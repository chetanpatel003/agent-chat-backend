import { runs } from "@trigger.dev/sdk";
import { prisma } from "@/lib/prisma";
import { requireChatOwnership, requireAgentRunOwnership } from "@/services/ownership";
import { ACTIVE_RUN_STATUSES, SkippedTransition } from "@/services/run-transitions";
import { NotFoundError } from "@/lib/errors";
import type { AgentRunResponse } from "@/contracts/agent-run";
import type { AgentRun } from "@/generated/prisma/client";
import type { AgentRunStatus } from "@/generated/prisma/enums";

const TERMINAL_RUN_STATUSES: AgentRunStatus[] = ["COMPLETED", "FAILED", "CANCELLED"];

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
    where: { chatId, status: { in: ACTIVE_RUN_STATUSES } },
  });
  return run ? toAgentRunResponse(run) : null;
}

/**
 * Cancellation transaction: CAS the AgentRun from an active status to
 * CANCELLED, and — in the same transaction — move its PENDING assistant
 * message (if any) to CANCELLED too, *without touching its content* so
 * whatever was already persisted (prior tool_use/tool_result blocks)
 * survives exactly as it was. Guarded the same way every other terminal
 * write in the worker is guarded (run-transitions.ts): if the AgentRun
 * is no longer active by the time this runs (a worker or a second
 * cancel request already finalized it), the whole transaction aborts
 * and nothing is written — never a race where the message gets
 * cancelled but the run doesn't, or vice versa.
 */
async function applyCancellation(agentRunId: string): Promise<{ applied: boolean }> {
  try {
    await prisma.$transaction(async (tx) => {
      const run = await tx.agentRun.updateMany({
        where: { id: agentRunId, status: { in: ACTIVE_RUN_STATUSES } },
        data: { status: "CANCELLED", completedAt: new Date(), errorCode: "CANCELLED_BY_USER" },
      });
      if (run.count === 0) throw new SkippedTransition();

      await tx.message.updateMany({
        where: { agentRunId, role: "ASSISTANT", status: "PENDING" },
        data: { status: "CANCELLED" },
      });
    });
    return { applied: true };
  } catch (error) {
    if (error instanceof SkippedTransition) return { applied: false };
    throw error;
  }
}

/**
 * POST .../runs/[runId]/cancel. Idempotent: a run that's already
 * terminal (by any path — completed, failed, or already cancelled) is
 * returned unchanged, with no write and no Trigger.dev call. Realtime
 * publishing is deliberately *not* done here — `metadata.append` only
 * means anything inside a live task execution, and this is a plain HTTP
 * request; cancellation becomes visible through the AgentRun's own
 * status (REST reconciliation — `GET .../runs/active`, or this
 * response itself), per PHASE2-PLAN.md §Decision B.
 */
export async function cancelRun(
  userId: string,
  chatId: string,
  agentRunId: string,
): Promise<AgentRunResponse> {
  await requireChatOwnership(userId, chatId);
  const run = await requireAgentRunOwnership(userId, agentRunId);
  // requireAgentRunOwnership already checked the run belongs to a chat
  // owned by this user; this additionally checks it's the *specific*
  // chat named in the URL, not just some chat of theirs — a 404, not a
  // 400, to stay consistent with "never leak which case applied."
  if (run.chatId !== chatId) throw new NotFoundError("Agent run not found");

  if (TERMINAL_RUN_STATUSES.includes(run.status)) {
    return toAgentRunResponse(run);
  }

  const { applied } = await applyCancellation(agentRunId);
  const updated = await prisma.agentRun.findUniqueOrThrow({ where: { id: agentRunId } });

  // Best-effort: PostgreSQL is already authoritative for the
  // application-level outcome by this point. A Trigger.dev run that's
  // mid-call will be caught by the worker's own guarded status checks
  // the moment it comes back, regardless of whether this call succeeds.
  if (applied && updated.triggerRunId) {
    try {
      await runs.cancel(updated.triggerRunId);
    } catch (error) {
      console.error("Trigger.dev run cancellation failed", {
        agentRunId,
        chatId,
        triggerRunId: updated.triggerRunId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return toAgentRunResponse(updated);
}
