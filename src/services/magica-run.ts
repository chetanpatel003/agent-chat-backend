import { wait } from "@trigger.dev/sdk";
import { prisma } from "@/lib/prisma";
import { getMagicaRun, MagicaPollInconclusiveError, type MagicaRunPoll } from "@/providers/magica";
import { readAgentRunStatus } from "@/services/run-transitions";

// Configurable via constants, not scattered magic numbers (per this
// checkpoint's own instruction). Deliberately well under Trigger.dev's
// configured maxDuration (trigger.config.ts: 3600s) — exhausting this
// budget is meant to be a rare safety valve, not the normal path for a
// real Magica job.
//
// 10s, not something smaller: read directly from the installed SDK
// (@trigger.dev/sdk's wait.js, `DURATION_WAIT_CHARGE_THRESHOLD_MS =
// 5000`), a `wait.for()` call of 5000ms or less takes a plain
// in-process `setTimeout` branch, never a real platform checkpoint —
// only a wait *longer* than 5s actually suspends the run (confirmed by
// reading the implementation, not assumed from the "durable wait"
// framing in the docs). 10s keeps every poll-wait on the real,
// checkpointing path with margin.
export const MAGICA_POLL_INTERVAL_SECONDS = 10;
export const MAGICA_POLL_MAX_ATTEMPTS = 60;
export const MAGICA_POLL_MAX_ELAPSED_MS = 5 * 60_000;

/** `wait.for()` itself (verified in the same source read above) throws
 * "wait.forToken can only be used from inside a task.run()" when
 * called outside a live Trigger.dev task context — the same category
 * of problem checkpoint 2.4 found with `metadata.append()`. Injected
 * here for exactly that reason, defaulting to the real primitive;
 * tests inject a fast no-op rather than needing a live task context,
 * the same DI pattern already used for the tool registry/publisher/
 * skill registry in `run-agent-turn.ts`. */
export type DurableWait = (seconds: number) => Promise<void>;
export const durableWait: DurableWait = (seconds) => wait.for({ seconds });

/**
 * Persists Magica's `runId` onto the already-created ToolInvocation row
 * identified by `invocationId` — called immediately after a successful
 * `202`, before any polling or durable wait, per this checkpoint's own
 * requirement. Guarded two ways: the row must still be `RUNNING` (not
 * already finalized by a racing process) AND must not already carry a
 * *different* `providerRunId` (a repeat call with the same value is
 * harmless and reported as applied; a different existing value is
 * refused rather than silently overwritten). If the write genuinely
 * cannot land, the caller must treat the run as having possibly
 * started but become untrackable — never retry the start because of
 * this specific failure.
 */
export async function persistProviderRunId(
  invocationId: string,
  providerRunId: string,
): Promise<{ applied: true } | { applied: false; currentProviderRunId: string | null }> {
  const result = await prisma.toolInvocation.updateMany({
    where: { id: invocationId, status: "RUNNING", providerRunId: null },
    data: { providerRunId },
  });
  if (result.count > 0) return { applied: true };

  const current = await prisma.toolInvocation.findUniqueOrThrow({
    where: { id: invocationId },
    select: { providerRunId: true },
  });
  // A repeat of the exact same write (e.g. a retried attempt that
  // already landed this value) is not a conflict.
  if (current.providerRunId === providerRunId) return { applied: true };
  return { applied: false, currentProviderRunId: current.providerRunId };
}

// `creditUsed` (checkpoint 3.3) flows through from Magica's own poll
// response, raw, for the caller to capture and persist as descriptive
// data only — never converted or settled. The credit-estimation unit
// discrepancy (project-docs/magica/CREDIT_ESTIMATION.md) remains
// unresolved; this is explicitly not a credits-charged/ledger value.
export type PollOutcome =
  | { status: "completed"; output: unknown; creditUsed?: number }
  | { status: "failed"; errorCode: string; errorMessage: string; creditUsed?: number };

/**
 * Polls an already-started Magica run to completion, using Trigger.dev's
 * durable `wait.for()` between attempts (verified against the installed
 * SDK — usable inside a `task.run()` block, checkpoints the run rather
 * than holding the process open; see project-docs/API_CONTRACTS.md).
 * Bounded by both a maximum attempt count and a maximum elapsed time.
 * Also stops promptly — without claiming Magica itself stopped — if
 * `agentRunId`'s own status is no longer `RUNNING` (the existing
 * cancellation route, or a terminal write from elsewhere), reusing the
 * already-established `readAgentRunStatus` primitive rather than new
 * plumbing.
 *
 * Every transient poll failure (`providers/magica.ts#getMagicaRun`
 * throws `MagicaAmbiguousError` uniformly for all of them) and every
 * unrecognized status is retried within budget, never surfaced as a
 * failure of the underlying run. Exhausting the budget — or detecting
 * local cancellation — throws `MagicaPollInconclusiveError`: this run
 * genuinely cannot be resolved *right now*, but nothing about that
 * implies failure, so the caller must never persist FAILED for it;
 * `providerRunId` stays intact for a later reconciliation attempt.
 */
export async function pollMagicaRunToCompletion(params: {
  agentRunId: string;
  providerRunId: string;
  waitFn?: DurableWait;
}): Promise<PollOutcome> {
  const { agentRunId, providerRunId, waitFn = durableWait } = params;
  const startedAt = Date.now();

  for (let attempt = 0; attempt < MAGICA_POLL_MAX_ATTEMPTS; attempt++) {
    if (Date.now() - startedAt > MAGICA_POLL_MAX_ELAPSED_MS) {
      throw new MagicaPollInconclusiveError("Polling budget (elapsed time) exhausted without a definitive outcome");
    }
    if ((await readAgentRunStatus(agentRunId)) !== "RUNNING") {
      // The run was cancelled (or otherwise left RUNNING) by something
      // else entirely — stop polling promptly. This says nothing about
      // whether Magica's own run stopped; only that it's no longer
      // this run's job to keep tracking it synchronously.
      throw new MagicaPollInconclusiveError("AgentRun is no longer RUNNING locally; stopping local polling");
    }

    let poll: MagicaRunPoll;
    try {
      poll = await getMagicaRun(providerRunId);
    } catch {
      // Every getMagicaRun() failure is transient by construction
      // (see its own doc comment) — retry the poll, not the run.
      await waitFn(MAGICA_POLL_INTERVAL_SECONDS);
      continue;
    }

    if (poll.status === "COMPLETED") {
      return { status: "completed", output: poll.output, creditUsed: poll.creditUsed };
    }
    if (poll.status === "FAILED" || poll.status === "CANCELED") {
      return {
        status: "failed",
        errorCode: poll.status === "FAILED" ? "MAGICA_RUN_FAILED" : "MAGICA_RUN_CANCELED",
        errorMessage: poll.userMessage ?? poll.error ?? `Magica run ended with status ${poll.status}`,
        creditUsed: poll.creditUsed,
      };
    }
    // QUEUED/RUNNING, or any other, unrecognized status — explicitly
    // not mapped to FAILED/COMPLETED; keep polling within budget
    // regardless of which pending or unrecognized value it is.
    await waitFn(MAGICA_POLL_INTERVAL_SECONDS);
  }

  throw new MagicaPollInconclusiveError("Polling budget (attempt count) exhausted without a definitive outcome");
}

/**
 * The `reconcile()` implementation shared by any Magica-backed tool:
 * never calls the start endpoint, only ever polls using the already-
 * persisted `providerRunId`. A missing `providerRunId` (the "crashed
 * after Magica accepted the start, before we could record the id"
 * case identified in the Phase 3.2 inspection) is not recoverable —
 * explicitly not treated as license to start a new run; it throws
 * `MagicaPollInconclusiveError` immediately, the same signal as an
 * exhausted polling budget.
 */
export async function reconcileMagicaRun(
  invocation: { id: string; providerRunId: string | null },
  waitFn: DurableWait = durableWait,
): Promise<PollOutcome> {
  if (!invocation.providerRunId) {
    throw new MagicaPollInconclusiveError(
      "No providerRunId was ever persisted for this invocation; cannot reconcile and must not start a new run",
    );
  }
  const run = await prisma.toolInvocation.findUniqueOrThrow({
    where: { id: invocation.id },
    select: { agentRunId: true },
  });
  const outcome = await pollMagicaRunToCompletion({
    agentRunId: run.agentRunId,
    providerRunId: invocation.providerRunId,
    waitFn,
  });
  return outcome;
}
