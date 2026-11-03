import { prisma } from "@/lib/prisma";
import { MessageContentSchema } from "@/contracts/message";
import { sanitizeAssistantText } from "@/contracts/assistant-text";
import { signedGetUrl, SIGNED_URL_DEFAULT_TTL_SECONDS } from "@/lib/b2";
import type { Attachment } from "@/generated/prisma/client";
import type { ProviderMessage } from "./openrouter";

// Most recent N complete messages, dropping only the oldest ones whole —
// never truncates inside a message's own content, which would change
// its meaning. A defensible, documented bound rather than an unbounded
// history load; tool calls aren't in scope this checkpoint, so only the
// `text` block is flattened into provider content. `thinking`/`reasoning`
// blocks are deliberately excluded here even when present — they're the
// model's own scratch output for this product's UI, not something that
// should be re-injected into its next turn's context as if it were
// prior dialogue.
const CONTEXT_MESSAGE_LIMIT = 40;

const ROLE_MAP = {
  USER: "user",
  ASSISTANT: "assistant",
  SYSTEM: "system",
  // No tool-role messages exist yet (tool calling isn't implemented
  // until checkpoint 2.3) — excluded below, not mapped.
} as const;

/**
 * A URL the model (and the tools it calls, e.g. Magica) can fetch for this
 * file. Archived files get a fresh one-hour signed B2 URL — scoped to this
 * turn's execution, never the raw key. Only never-archived uploads fall
 * back to their stored URL. A file that can't be signed is left out.
 */
async function contextUrl(attachment: Attachment, ownerUserId: string): Promise<string | null> {
  if (attachment.storageKey) {
    try {
      return await signedGetUrl(attachment.storageKey, ownerUserId, SIGNED_URL_DEFAULT_TTL_SECONDS);
    } catch (error) {
      console.error("Context URL signing failed", {
        attachmentId: attachment.id,
        error: error instanceof Error ? error.name : "UnknownError",
      });
      return null;
    }
  }
  return attachment.source === "UPLOAD" ? attachment.url : null;
}

/** Files are listed in order with their verified type, so the model can
 * pass image URLs to image tools and video URLs to merge_videos. */
async function fileList(label: string, attachments: Attachment[], ownerUserId: string): Promise<string> {
  const entries: string[] = [];
  for (const attachment of attachments) {
    const url = await contextUrl(attachment, ownerUserId);
    if (url) entries.push(`${entries.length + 1}. ${attachment.mimeType} ${url}`);
  }
  return entries.length ? `${label} (in order):\n${entries.join("\n")}` : "";
}

/**
 * `sent`: what a user message sent, already in send order (direct uploads
 * and media-library picks, which may be generated files). `own`: a
 * message's own outputs (an assistant turn's generated files).
 */
async function withFiles(
  text: string,
  sent: Attachment[],
  own: Attachment[],
  ownerUserId: string,
): Promise<string> {
  // Generated: per invocation (rows of one invocation share createdAt), then output order.
  const generated = own
    .filter((a) => a.source === "GENERATED")
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.order - b.order);
  const sections = [
    text,
    await fileList("Attached files", sent, ownerUserId),
    await fileList("Generated files", generated, ownerUserId),
  ].filter(Boolean);
  return sections.join("\n\n").trim();
}

/**
 * Builds the OpenRouter-ready message list from this chat's persisted
 * history. Only COMPLETE messages are included — a PENDING placeholder
 * (including the one about to be inserted for this very turn, which
 * doesn't exist yet when this runs) or a FAILED turn has nothing usable
 * to show the model, so both are excluded, not sent as empty turns.
 * `ownerUserId` is the chat's owner (the run's user).
 */
export async function buildConversationContext(chatId: string, ownerUserId: string): Promise<ProviderMessage[]> {
  const rows = await prisma.message.findMany({
    where: { chatId, status: "COMPLETE", role: { in: ["USER", "ASSISTANT", "SYSTEM"] } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: CONTEXT_MESSAGE_LIMIT,
    include: {
      attachments: { where: { status: "READY", source: "GENERATED" } },
      sentAttachments: { where: { attachment: { status: "READY" } }, orderBy: { order: "asc" }, include: { attachment: true } },
    },
  });

  const messages = await Promise.all(
    rows
      .reverse() // back to chronological order after the DESC/take bound
      .map(async (row) => {
        const blocks = MessageContentSchema.parse(row.content);
        const text = blocks
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        // A past reply that echoed media URLs (or copied a file list) is not
        // shown back to the model — it would learn to repeat it. The file
        // lists below are the one place URLs are given, as tool inputs.
        const shownText = row.role === "ASSISTANT" ? sanitizeAssistantText(text) : text;
        return {
          role: ROLE_MAP[row.role as keyof typeof ROLE_MAP],
          content: await withFiles(
            shownText,
            row.sentAttachments.map((s) => s.attachment),
            row.attachments,
            ownerUserId,
          ),
        };
      }),
  );
  return messages.filter((m) => m.content.length > 0);
}
