import { prisma } from "@/lib/prisma";
import { ValidationError } from "@/lib/errors";
import { requireChatOwnership } from "@/services/ownership";
import { decodeCursor, encodeCursor } from "@/contracts/pagination";
import {
  MessageContentSchema,
  type MessageResponse,
  type PaginatedMessageResponse,
} from "@/contracts/message";
import type { Message, Prisma } from "@/generated/prisma/client";

function toMessageResponse(message: Message): MessageResponse {
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
    content: MessageContentSchema.parse(message.content),
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
  });

  const hasMore = rows.length > opts.limit;
  const page = rows.slice(0, opts.limit).reverse(); // -> chronological ascending
  const oldest = page[0];
  const olderCursor =
    hasMore && oldest
      ? encodeCursor({ sortKey: oldest.createdAt.toISOString(), id: oldest.id })
      : null;

  return { items: page.map(toMessageResponse), olderCursor, hasMore };
}
