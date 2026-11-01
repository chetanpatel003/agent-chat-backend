import { prisma } from "@/lib/prisma";
import { MessageContentSchema } from "@/contracts/message";
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
 * Builds the OpenRouter-ready message list from this chat's persisted
 * history. Only COMPLETE messages are included — a PENDING placeholder
 * (including the one about to be inserted for this very turn, which
 * doesn't exist yet when this runs) or a FAILED turn has nothing usable
 * to show the model, so both are excluded, not sent as empty turns.
 */
export async function buildConversationContext(chatId: string): Promise<ProviderMessage[]> {
  const rows = await prisma.message.findMany({
    where: { chatId, status: "COMPLETE", role: { in: ["USER", "ASSISTANT", "SYSTEM"] } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: CONTEXT_MESSAGE_LIMIT,
  });

  return rows
    .reverse() // back to chronological order after the DESC/take bound
    .map((row) => {
      const blocks = MessageContentSchema.parse(row.content);
      const text = blocks
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return { role: ROLE_MAP[row.role as keyof typeof ROLE_MAP], content: text };
    })
    .filter((m) => m.content.length > 0);
}
