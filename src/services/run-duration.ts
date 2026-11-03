import { ACTIVE_RUN_STATUSES } from "@/services/run-transitions";
import type { AgentRunStatus, MessageStatus } from "@/generated/prisma/enums";

export type RunTiming = {
  status: AgentRunStatus;
  createdAt: Date | null;
  completedAt: Date | null;
};

/**
 * A finished turn's measured wall-clock duration: from the run's admission
 * (`createdAt`, i.e. when the user sent the message) to its terminal
 * `completedAt`. Includes queueing, every model round, every tool call
 * (e.g. a multi-minute Merge Videos) and any approval wait — what the user
 * actually waited. Distinct from `thinkingMs`, which is model time only.
 *
 * Null — never an estimate — while the run is still active, or when either
 * timestamp is missing or invalid, or the two are out of order.
 *
 * Also null when the message finished after its run did: a COMPLETE message
 * on a run that did not complete means a tool result was recovered and
 * attached later (tool-reconciliation H2), so the run's `completedAt` is not
 * when the turn's output actually arrived and the duration is unknown.
 */
export function runDurationMs(run: RunTiming | null, messageStatus?: MessageStatus): number | null {
  if (!run || ACTIVE_RUN_STATUSES.includes(run.status)) return null;
  if (messageStatus === "COMPLETE" && run.status !== "COMPLETED") return null;
  const start = run.createdAt?.getTime();
  const end = run.completedAt?.getTime();
  if (start === undefined || end === undefined || !Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (end < start) return null;
  return end - start;
}
