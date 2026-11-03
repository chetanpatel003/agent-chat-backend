import { prisma } from "@/lib/prisma";
import { ValidationError } from "@/lib/errors";
import { requireChatOwnership } from "@/services/ownership";
import { decodeCursor, encodeCursor } from "@/contracts/pagination";
import {
  MessageContentSchema,
  type MessageResponse,
  type PaginatedMessageResponse,
} from "@/contracts/message";
import { toAttachmentResponse } from "@/services/attachment";
import { sanitizeAssistantText } from "@/contracts/assistant-text";
import type { Attachment, Message, Prisma } from "@/generated/prisma/client";
import type { AgentRunStatus } from "@/generated/prisma/enums";
import { ACTIVE_RUN_STATUSES } from "@/services/run-transitions";
import { runDurationMs } from "@/services/run-duration";

/** `ownerUserId` is the authenticated caller, already verified as the chat's owner. */
type MessageRow = Message & {
  /** Origin attachments: an assistant message's generated outputs. */
  attachments: Attachment[];
  /** A user message's attachments, in send order (uploads and media-library picks). */
  sentAttachments: { attachment: Attachment }[];
  agentRun: {
    status: AgentRunStatus;
    errorCode: string | null;
    errorMessage: string | null;
    createdAt: Date;
    completedAt: Date | null;
  } | null;
};

/**
 * An assistant message that ended early carries its run's user-safe reason:
 * a FAILED/CANCELLED message, and also a still-PENDING message whose run has
 * ended (a run recovered as RUN_INTERRUPTED, or an ambiguous outcome, keeps
 * its message PENDING as evidence). Derived on read; nothing is rewritten.
 */
function messageError(message: MessageRow): MessageResponse["error"] {
  if (message.role !== "ASSISTANT") return null;
  const run = message.agentRun;
  if (!run?.errorCode) return null;
  const ended =
    message.status === "FAILED" ||
    message.status === "CANCELLED" ||
    (message.status === "PENDING" && !ACTIVE_RUN_STATUSES.includes(run.status));
  return ended ? { code: run.errorCode, message: run.errorMessage ?? "" } : null;
}

/** A user message shows what it sent (join table, send order); any other message its own outputs. */
function attachmentsOf(message: MessageRow): Attachment[] {
  return message.role === "USER" ? message.sentAttachments.map((s) => s.attachment) : message.attachments;
}

/** Settled charge per ToolInvocation id (with the message it belongs to). */
type SettledCharges = ReadonlyMap<string, { messageId: string; charged: number }>;

/**
 * A tool_result block records `creditsCharged` when the turn writes it; an
 * invocation settled afterwards (recovery sweep, durable settlement task)
 * leaves that null in the stored block. Presentation only: read the
 * settled amount from ToolInvocation so the UI can show it — nothing is
 * written, and settlement/ledger logic is untouched.
 */
async function settledChargesFor(messages: MessageRow[]): Promise<SettledCharges> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== "ASSISTANT") continue;
    const parsed = MessageContentSchema.safeParse(message.content);
    if (!parsed.success) continue;
    for (const block of parsed.data) {
      if (block.type === "tool_result" && block.creditsCharged === null && block.error === null) ids.add(block.toolInvocationId);
    }
  }
  if (ids.size === 0) return new Map();
  const settled = await prisma.toolInvocation.findMany({
    // Scoped to this page's own messages (already ownership-checked).
    where: { id: { in: [...ids] }, messageId: { in: messages.map((m) => m.id) }, creditsCharged: { not: null } },
    select: { id: true, messageId: true, creditsCharged: true },
  });
  return new Map(
    settled.flatMap((i) => (i.messageId ? [[i.id, { messageId: i.messageId, charged: Number(i.creditsCharged) }] as const] : [])),
  );
}

async function toMessageResponse(message: MessageRow, ownerUserId: string, settled: SettledCharges = new Map()): Promise<MessageResponse> {
  return {
    id: message.id,
    chatId: message.chatId,
    agentRunId: message.agentRunId,
    role: message.role,
    status: message.status,
    // Validated on the way out, not just trusted from the DB — the write
    // path (not built yet) is responsible for writing valid blocks, but
    // this is still a real trust boundary per "Zod at every trust
    // boundary": a response is never shipped on the assumption that
    // whatever's in the column already matches the contract.
    // thinking/reasoning blocks hold private model reasoning persisted by
    // older turns; they are never part of the user-visible payload.
    // Assistant prose never carries generated-media/signed URLs or its own
    // credit statements (the app shows media and settled usage itself);
    // existing rows are cleaned here, on the way out, never rewritten.
    content: MessageContentSchema.parse(message.content)
      .filter((block) => block.type !== "thinking" && block.type !== "reasoning")
      .map((block) => {
        if (message.role !== "ASSISTANT") return block;
        if (block.type === "text") return { ...block, text: sanitizeAssistantText(block.text) };
        if (block.type === "tool_result" && block.creditsCharged === null) {
          // Only the invocation that belongs to this very message.
          const found = settled.get(block.toolInvocationId);
          if (found && found.messageId === message.id) return { ...block, creditsCharged: found.charged };
        }
        return block;
      }),
    attachments: await Promise.all(attachmentsOf(message).map((a) => toAttachmentResponse(a, ownerUserId))),
    thinkingMs: message.thinkingMs,
    runDurationMs: message.role === "ASSISTANT" ? runDurationMs(message.agentRun) : null,
    error: messageError(message),
    createdAt: message.createdAt.toISOString(),
  };
}

/**
 * Chronological (oldest-first) pages, newest page by default, each older
 * page fetched via the previous page's `olderCursor`. Internally this
 * queries DESC (createdAt, id) — the natural direction for "give me the
 * N most recent, then let me page backward" — and reverses the slice
 * before returning, so `items` is always oldest-to-newest regardless of
 * which page it is. See contracts/message.ts for why the cursor field
 * is named olderCursor instead of a generic nextCursor.
 */
export async function listMessages(
  userId: string,
  chatId: string,
  opts: { cursor?: string; limit: number },
): Promise<PaginatedMessageResponse> {
  await requireChatOwnership(userId, chatId);

  const decoded = opts.cursor ? decodeCursor(opts.cursor) : null;
  if (opts.cursor && !decoded) {
    throw new ValidationError("Invalid cursor");
  }

  const where: Prisma.MessageWhereInput = { chatId };
  if (decoded) {
    const cursorDate = new Date(decoded.sortKey);
    where.OR = [
      { createdAt: { lt: cursorDate } },
      { createdAt: cursorDate, id: { lt: decoded.id } },
    ];
  }

  const rows = await prisma.message.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: opts.limit + 1,
    include: {
      attachments: { orderBy: { order: "asc" } },
      sentAttachments: { orderBy: { order: "asc" }, include: { attachment: true } },
      agentRun: { select: { status: true, errorCode: true, errorMessage: true, createdAt: true, completedAt: true } },
    },
  });

  const hasMore = rows.length > opts.limit;
  const page = rows.slice(0, opts.limit).reverse(); // -> chronological ascending
  const oldest = page[0];
  const olderCursor =
    hasMore && oldest
      ? encodeCursor({ sortKey: oldest.createdAt.toISOString(), id: oldest.id })
      : null;

  const settled = await settledChargesFor(page);
  return { items: await Promise.all(page.map((m) => toMessageResponse(m, userId, settled))), olderCursor, hasMore };
}
