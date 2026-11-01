import { prisma } from "@/lib/prisma";
import { requireChatOwnership } from "@/services/ownership";
import type { AgentRunResponse } from "@/contracts/agent-run";
import type { AgentRun } from "@/generated/prisma/client";

function toAgentRunResponse(run: AgentRun): AgentRunResponse {
  return {
    id: run.id,
    chatId: run.chatId,
    status: run.status,
    waitingReason: run.waitingReason,
    model: run.model,
    promptTokens: run.promptTokens,
    completionTokens: run.completionTokens,
    turnCount: run.turnCount,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}

/** The reconciliation endpoint a client polls after reload/reconnect —
 * "is something in flight for this chat right now." Non-active (terminal)
 * runs are never returned here; read them via message history instead. */
export async function getActiveRun(
  userId: string,
  chatId: string,
): Promise<AgentRunResponse | null> {
  await requireChatOwnership(userId, chatId);
  const run = await prisma.agentRun.findFirst({
    where: { chatId, status: { in: ["QUEUED", "RUNNING", "WAITING"] } },
  });
  return run ? toAgentRunResponse(run) : null;
}
