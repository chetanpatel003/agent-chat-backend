import { ACTIVE_RUN_STATUSES } from "@/services/run-transitions";
import type { AgentRunStatus } from "@/generated/prisma/enums";

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
 */
export function runDurationMs(run: RunTiming | null): number | null {
  if (!run || ACTIVE_RUN_STATUSES.includes(run.status)) return null;
  const start = run.createdAt?.getTime();
  const end = run.completedAt?.getTime();
  if (start === undefined || end === undefined || !Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (end < start) return null;
  return end - start;
}
