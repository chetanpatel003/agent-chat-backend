# 0016 — Stuck AgentRun: transaction timeouts, execution-aware re-entry, stale-run sweep

Status: accepted (2026-11-03). Found in browser verification of 0015.

## Observed failure
1. OpenRouter returned a definite error after ~28.5 s (code not recorded — it was never logged).
2. `markDefiniteFailure`'s interactive transaction used Prisma's defaults (`maxWait` 2 s,
   `timeout` 5 s) and failed with "Unable to start a transaction in the given time". Opening a
   new pooled Neon connection was measured at ~3.4 s from the dev environment.
3. The error escaped `executeAgentTurn`; Trigger.dev retried.
4. The retry's re-entry found the PENDING assistant message, but `isAgentRunRecentlyActive`
   (updatedAt < 120 s) said "maybe a live sibling", so it returned `skipped` — successfully.
   Trigger.dev recorded the run COMPLETED: no further attempt.
5. Nothing else ever revisited the run: RUNNING forever, empty PENDING message, chat blocked
   (one active run per chat) until Stop.

## Decisions
1. **Transaction options.** Every run-transition interactive transaction uses
   `RUN_TRANSITION_TRANSACTION_OPTIONS = { maxWait: 10 000, timeout: 20 000 }`
   (`services/run-transitions.ts`) — the values already used by credit settlement:
   `markDefiniteFailure`, `finalizeSuccess` (run-agent-turn), cancel (`agent-run.ts`), interrupt
   admission (`send-turn.ts`), waitpoint expiry, and the new sweep. 10 s covers a cold connection
   (~3.4 s) with margin; 20 s bounds a 3–5 statement transaction at ~300 ms per round trip under
   contention. Credit settlement itself is unchanged.
2. **Log before persisting.** Provider failures are logged (`Provider call failed`: agentRunId,
   messageId, round, our error code, partial-text length; `Provider call outcome unknown`: error
   class) before any database write. Never the provider message, partial text, prompt or keys.
3. **Execution-aware re-entry.** The task passes `ctx.run.id` and `ctx.attempt.number`. A retry
   attempt (> 1) of the Trigger.dev run that owns the AgentRun proves the previous attempt ended
   (attempts never overlap), so re-entry recovers at once (existing ambiguous outcome: no second
   provider request, message content kept) instead of deferring to the 120 s liveness gate. Any
   other execution (first attempt, another run id, no context) keeps the liveness gate, which
   still protects against genuinely concurrent executions.
4. **Stale-run sweep** `recover-stale-runs` (every 5 min, `concurrencyLimit: 1`), for the case
   where no retry is left. Eligible only if all hold:
   - AgentRun is QUEUED/RUNNING/WAITING and untouched for 5 min;
   - it has a recorded `triggerRunId`;
   - Trigger.dev reports that run **finished** (COMPLETED, FAILED, CANCELED, CRASHED,
     SYSTEM_FAILURE, TIMED_OUT, EXPIRED). QUEUED/DEQUEUED/EXECUTING/WAITING/DELAYED/
     PENDING_VERSION are live and never touched, whatever `updatedAt` says.
   The write is a compare-and-set on `status ∈ active AND updatedAt = observed`, so a completion,
   cancellation or any newer progress written since makes it a no-op. Outcome: AgentRun FAILED
   `RUN_INTERRUPTED` (user-safe retry hint), open waitpoints CANCELLED; the assistant message
   keeps its content and status (as the existing ambiguous path). Never calls the provider or
   re-triggers the task. Batches of 25.

## Limitations
- After recovery the assistant message stays PENDING (existing ambiguous-outcome convention), so
  the UI still renders it as an in-progress bubble; changing that convention is a separate decision.
- A run whose `triggerRunId` was never recorded cannot be proven dead and is left for Stop.
- Trigger.dev status is read, not locked. A finished Trigger.dev run is not resumed by
  Trigger.dev (a replay is a new run with a new id), and any write made after the sweep's read
  defeats the CAS, so the remaining window is a write-free gap that cannot belong to a live attempt.
- Thresholds are fixed constants (5 min staleness, 5 min cadence): a stuck run is released within
  roughly 5–10 min, not instantly.

## Follow-up (2026-11-03, browser verification of the worker-restart case)
Observed: in dev, restarting the Trigger.dev worker CANCELED a run waiting on a PLAN token;
Reject then resolved the waitpoint and completed the token, but nothing consumed it; the sweep
recovered the run 5 min later, and the UI showed its PENDING message as a finished answer.

5. **Resolve checks the execution first.** `resolveWaitpoint` reads the Trigger.dev run status
   before applying a decision (and before redelivering a saved one to a still-WAITING run):
   - live (PENDING_VERSION, QUEUED, DEQUEUED, EXECUTING, WAITING, DELAYED) → proceed as before;
   - finished (COMPLETED, FAILED, CANCELED, CRASHED, SYSTEM_FAILURE, TIMED_OUT, EXPIRED) →
     `interruptRun` (shared with the sweep): guarded AgentRun active → FAILED `RUN_INTERRUPTED`,
     PENDING waitpoints → CANCELLED, message untouched; respond **409 `RunInterruptedError`**.
     The decision is never recorded or reported as applied; concurrent requests make one transition;
   - unreadable, unrecognised, or no recorded `triggerRunId` → **503
     `ExecutionStatusUnavailableError`** (retryable), nothing changed, approval stays pending.
   The 5-minute sweep remains the fallback when nobody submits a decision.
6. **Display.** A PENDING assistant message whose run has ended now carries the run's reason in
   `MessageResponse.error` (derived on read; persistence unchanged). The UI renders
   `RUN_INTERRUPTED` as "Response interrupted — The execution stopped unexpectedly. Send a new
   message to continue." with any content kept, and any other ended-PENDING reason as an error;
   never an endless "Thinking…", never a finished answer.

Remaining: the status check and the resolve are not atomic — an execution that dies after a
"live" read still gets the decision recorded and its token completed with no consumer; the sweep
then interrupts the run within ~5–10 min. Status updates for these transitions reach the client
via REST (the 409 response and query invalidation), not realtime: a finished Trigger.dev run
cannot publish metadata and the SDK has no out-of-task metadata write.
