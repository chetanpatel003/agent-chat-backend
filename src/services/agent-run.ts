import { runs, auth } from "@trigger.dev/sdk";
import { prisma } from "@/lib/prisma";
import { requireChatOwnership, requireAgentRunOwnership } from "@/services/ownership";
import { ACTIVE_RUN_STATUSES, RUN_TRANSITION_TRANSACTION_OPTIONS, SkippedTransition } from "@/services/run-transitions";
import { NotFoundError, ValidationError } from "@/lib/errors";
import type { AgentRunResponse, RealtimeTokenResponse } from "@/contracts/agent-run";
import type { AgentRun, Prisma } from "@/generated/prisma/client";
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
    planMode: run.planMode,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    triggerRunId: run.triggerRunId,
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

/** One run of this chat, in any state. Another user's (or chat's) run is a 404. */
export async function getRun(userId: string, chatId: string, agentRunId: string): Promise<AgentRunResponse> {
  await requireChatOwnership(userId, chatId);
  const run = await requireAgentRunOwnership(userId, agentRunId);
  if (run.chatId !== chatId) throw new NotFoundError("Agent run not found");
  return toAgentRunResponse(run);
}

/**
 * Mints a short-lived, read-only Trigger.dev public access token scoped
 * to exactly this one run — the only way a browser can open a realtime
 * subscription without ever holding the Trigger.dev secret key (which
 * stays server-side; see node_modules' own auth.d.ts for the API this
 * wraps). 1h expiration: comfortably longer than any real chat turn
 * (observed this trial: 10–33s), short enough to bound exposure if a
 * token were somehow retained past the page that requested it.
 */
export async function getRealtimeToken(
  userId: string,
  chatId: string,
  agentRunId: string,
): Promise<RealtimeTokenResponse> {
  await requireChatOwnership(userId, chatId);
  const run = await requireAgentRunOwnership(userId, agentRunId);
  if (run.chatId !== chatId) throw new NotFoundError("Agent run not found");
  if (!run.triggerRunId) {
    throw new ValidationError("This run has not been dispatched yet");
  }

  const token = await auth.createPublicToken({
    scopes: { read: { runs: [run.triggerRunId] } },
    expirationTime: "1h",
  });
  return { token };
}

export const CANCELLED_BY_USER = "CANCELLED_BY_USER";
export const INTERRUPTED_BY_USER = "INTERRUPTED_BY_USER";

/**
 * Cancellation inside a caller's transaction: CAS the AgentRun from an
 * active status to CANCELLED, move its PENDING assistant message to
 * CANCELLED *without touching its content* (persisted text, tool blocks
 * and streamed partial text survive), and cancel any open waitpoint so a
 * late decision can't resume it. Returns false (nothing written) when the
 * run is no longer active — a worker or another cancel already finalized it.
 * Used by Stop (cancelRun) and by Interrupt (send-turn's admission).
 */
export async function cancelActiveRunInTx(
  tx: Prisma.TransactionClient,
  agentRunId: string,
  errorCode: typeof CANCELLED_BY_USER | typeof INTERRUPTED_BY_USER,
): Promise<boolean> {
  const run = await tx.agentRun.updateMany({
    where: { id: agentRunId, status: { in: ACTIVE_RUN_STATUSES } },
    data: { status: "CANCELLED", completedAt: new Date(), errorCode, waitingReason: null },
  });
  if (run.count === 0) return false;
  await tx.message.updateMany({
    where: { agentRunId, role: "ASSISTANT", status: "PENDING" },
    data: { status: "CANCELLED" },
  });
  await tx.waitpoint.updateMany({ where: { agentRunId, status: "PENDING" }, data: { status: "CANCELLED" } });
  return true;
}

async function applyCancellation(agentRunId: string): Promise<{ applied: boolean }> {
  try {
    await prisma.$transaction(async (tx) => {
      if (!(await cancelActiveRunInTx(tx, agentRunId, CANCELLED_BY_USER))) throw new SkippedTransition();
    }, RUN_TRANSITION_TRANSACTION_OPTIONS);
    return { applied: true };
  } catch (error) {
    if (error instanceof SkippedTransition) return { applied: false };
    throw error;
  }
}

/** Best-effort: PostgreSQL is already authoritative; the worker's guarded
 * checks stop it regardless of whether this call succeeds. */
export async function cancelTriggerRunBestEffort(triggerRunId: string | null, log: Record<string, unknown>) {
  if (!triggerRunId) return;
  try {
    await runs.cancel(triggerRunId);
  } catch (error) {
    console.error("Trigger.dev run cancellation failed", {
      ...log,
      triggerRunId,
      error: error instanceof Error ? error.message : String(error),
    });
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

  if (applied) await cancelTriggerRunBestEffort(updated.triggerRunId, { agentRunId, chatId });

  return toAgentRunResponse(updated);
}
