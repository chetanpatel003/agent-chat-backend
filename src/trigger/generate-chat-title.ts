import { task } from "@trigger.dev/sdk";
import { z } from "zod";
import { titleChatFromFirstMessage, type TitleOutcome } from "@/services/chat-title";

// Titles a new chat from its first message, off the request path: dispatched
// after the turn is dispatched, never awaited by it. Idempotent per chat (its
// key) and safe to repeat (the write only applies while the title is NULL).

const PayloadSchema = z.object({ chatId: z.uuid() });
export type GenerateChatTitlePayload = z.infer<typeof PayloadSchema>;

export async function runGenerateChatTitle(payload: unknown): Promise<TitleOutcome> {
  return titleChatFromFirstMessage(PayloadSchema.parse(payload).chatId);
}

export const generateChatTitle = task({
  id: "generate-chat-title",
  // generateTitle never throws (it falls back); only e.g. a DB outage is retried.
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 2_000, maxTimeoutInMs: 20_000, randomize: true },
  run: (payload: GenerateChatTitlePayload) => runGenerateChatTitle(payload),
});

export function chatTitleIdempotencyKey(chatId: string): string {
  return `chat-title:${chatId}`;
}

/** Never throws: a failed dispatch leaves the chat untitled ("New chat"); the send is unaffected. */
export async function dispatchChatTitle(chatId: string): Promise<boolean> {
  try {
    await generateChatTitle.trigger({ chatId }, { idempotencyKey: chatTitleIdempotencyKey(chatId), idempotencyKeyTTL: "30d" });
    return true;
  } catch (error) {
    console.error("Chat title dispatch failed", { chatId, error: error instanceof Error ? error.name : "UnknownError" });
    return false;
  }
}
