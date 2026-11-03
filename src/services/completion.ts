import { prisma } from "@/lib/prisma";
import { createChat } from "@/services/chat";
import { sendTurn } from "@/services/send-turn";
import type { CompletionRequest, CompletionResponse } from "@/contracts/completion";

/**
 * POST /api/v1/completions. Idempotent on the caller's Idempotency-Key: a
 * retry returns the original dispatch (and never creates a second chat).
 */
export async function createCompletion(
  userId: string,
  idempotencyKey: string,
  input: CompletionRequest,
): Promise<CompletionResponse> {
  const previous = await prisma.agentRun.findUnique({ where: { idempotencyKey }, select: { userId: true, chatId: true } });
  const chatId =
    previous?.userId === userId ? previous.chatId : (input.chatId ?? (await createChat(userId, {})).id);
  const sent = await sendTurn(userId, chatId, idempotencyKey, input);
  return {
    chatId: sent.chatId,
    runId: sent.runId,
    messageId: sent.messageId,
    status: "QUEUED",
    links: {
      run: `/api/v1/chats/${sent.chatId}/runs/${sent.runId}`,
      messages: `/api/v1/chats/${sent.chatId}/messages`,
    },
  };
}
