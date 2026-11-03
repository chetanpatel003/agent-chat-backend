import { runs } from "@trigger.dev/sdk";
import { prisma } from "@/lib/prisma";
import { ACTIVE_RUN_STATUSES, RUN_TRANSITION_TRANSACTION_OPTIONS, SkippedTransition } from "@/services/run-transitions";

// Safety net for an AgentRun left active (QUEUED/RUNNING/WAITING) with no
// execution left to finish it — e.g. an attempt that crashed and whose retry
// backed off, or a worker that died while waiting. Eligibility needs BOTH:
//  1. no write to the AgentRun for STALE_ACTIVE_RUN_THRESHOLD_MS, and
//  2. Trigger.dev reporting its run as finished (a terminal status).
// A run Trigger.dev still reports as queued/executing/waiting/delayed is
// never touched, however old its updatedAt: that is the live-execution
// protection. Recovery never calls the provider and never re-triggers the
// task; the outcome is unknown, so the run ends FAILED with a retry hint and
// the assistant message keeps its content (left PENDING, as the existing
// ambiguous-outcome path does).

/** Long enough that a just-finished attempt's own terminal write has landed. */
export const STALE_ACTIVE_RUN_THRESHOLD_MS = 5 * 60_000;
export const STALE_RUN_RECOVERY_BATCH_SIZE = 25;
export const RUN_INTERRUPTED_CODE = "RUN_INTERRUPTED";
export const RUN_INTERRUPTED_MESSAGE = "The execution stopped unexpectedly. Send a new message to continue.";

/** Trigger.dev run statuses after which no attempt will run again. */
export const FINISHED_TRIGGER_RUN_STATUSES: ReadonlySet<string> = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELED",
  "CRASHED",
  "SYSTEM_FAILURE",
  "TIMED_OUT",
  "EXPIRED",
]);

export type StaleRunRecoveryDeps = {
  /** Trigger.dev's current status for a run id. */
  triggerRunStatus: (triggerRunId: string) => Promise<string>;
};

export const triggerRunStatus: StaleRunRecoveryDeps["triggerRunStatus"] = async (triggerRunId) =>
  (await runs.retrieve(triggerRunId)).status;

export type StaleRunRecoverySummary = {
  checked: number;
  recovered: number;
  stillLive: number;
  noTriggerRun: number;
  statusUnavailable: number;
  raced: number;
};

/** Trigger.dev run statuses in which an attempt is, or will be, running. */
export const LIVE_TRIGGER_RUN_STATUSES: ReadonlySet<string> = new Set([
  "PENDING_VERSION",
  "QUEUED",
  "DEQUEUED",
  "EXECUTING",
  "WAITING",
  "DELAYED",
]);

/**
 * Ends a run whose execution is gone: AgentRun active → FAILED
 * RUN_INTERRUPTED, open waitpoints → CANCELLED, assistant message (and its
 * content) untouched. Guarded: only while still active and, when
 * `observedUpdatedAt` is given, untouched since then — so a completion, a
 * cancellation or newer progress is never overwritten. Returns whether this
 * call made the transition (a concurrent duplicate gets false).
 */
export async function interruptRun(agentRunId: string, guard: { observedUpdatedAt?: Date } = {}): Promise<boolean> {
  try {
    await prisma.$transaction(async (tx) => {
      const run = await tx.agentRun.updateMany({
        where: {
          id: agentRunId,
          status: { in: ACTIVE_RUN_STATUSES },
          ...(guard.observedUpdatedAt ? { updatedAt: guard.observedUpdatedAt } : {}),
        },
        data: {
          status: "FAILED",
          waitingReason: null,
          errorCode: RUN_INTERRUPTED_CODE,
          errorMessage: RUN_INTERRUPTED_MESSAGE,
          completedAt: new Date(),
        },
      });
      if (run.count === 0) throw new SkippedTransition();
      // A decision on a run that can no longer resume must be refused.
      await tx.waitpoint.updateMany({ where: { agentRunId, status: "PENDING" }, data: { status: "CANCELLED" } });
    }, RUN_TRANSITION_TRANSACTION_OPTIONS);
    return true;
  } catch (error) {
    if (error instanceof SkippedTransition) return false;
    throw error;
  }
}

export async function sweepStaleRuns(deps: StaleRunRecoveryDeps, now = new Date()): Promise<StaleRunRecoverySummary> {
  const summary: StaleRunRecoverySummary = {
    checked: 0,
    recovered: 0,
    stillLive: 0,
    noTriggerRun: 0,
    statusUnavailable: 0,
    raced: 0,
  };
  const candidates = await prisma.agentRun.findMany({
    where: {
      status: { in: ACTIVE_RUN_STATUSES },
      updatedAt: { lt: new Date(now.getTime() - STALE_ACTIVE_RUN_THRESHOLD_MS) },
    },
    orderBy: { updatedAt: "asc" },
    take: STALE_RUN_RECOVERY_BATCH_SIZE,
    select: { id: true, triggerRunId: true, updatedAt: true, status: true },
  });

  for (const run of candidates) {
    summary.checked++;
    const log = { agentRunId: run.id, triggerRunId: run.triggerRunId, status: run.status };
    // Never dispatched/recorded: no way to prove nothing is running. Left alone.
    if (!run.triggerRunId) {
      summary.noTriggerRun++;
      continue;
    }
    let triggerStatus: string;
    try {
      triggerStatus = await deps.triggerRunStatus(run.triggerRunId);
    } catch (error) {
      summary.statusUnavailable++; // the next sweep retries
      console.error("Stale run recovery: Trigger.dev status unavailable", {
        ...log,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!FINISHED_TRIGGER_RUN_STATUSES.has(triggerStatus)) {
      summary.stillLive++; // an execution may still finish it
      continue;
    }
    if (await interruptRun(run.id, { observedUpdatedAt: run.updatedAt })) {
      summary.recovered++;
      console.warn("Stale run recovered", { ...log, triggerStatus });
    } else {
      summary.raced++;
    }
  }
  return summary;
}
