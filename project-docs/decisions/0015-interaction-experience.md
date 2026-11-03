# 0015 — Core interaction experience: streaming, waitpoints, interrupt, parallel tools

Status: accepted (2026-11-03). Approved choices: in-process bounded parallelism (limit 3),
PLAN timeout 24 h, `Waitpoint(status, expiresAt)` index.

## Decisions
1. **One approval mechanism.** The existing `Waitpoint` table is authoritative; a Trigger.dev
   waitpoint token (created with the row's idempotency key) is only what the run suspends on.
   Decisions commit to PostgreSQL before the token is completed; a token is completed only while
   `WAITING`; the run resumes via a guarded WAITING→RUNNING transition reading the row. This
   makes resumption exactly-once and makes "DB committed, completeToken failed" recoverable by
   repeating the request (same token) or by the sweep.
2. **Plan mode is a run property** (`AgentRun.planMode`), not only task payload, so it is
   durable and visible over REST.
3. **Streaming over a separate typed stream**, never metadata (assessment: "stream text
   separately from run metadata"). PostgreSQL gets throttled partial flushes so failure, stop
   and reload never lose more than ~1 s of text.
4. **Mid-stream failures are definite**, not ambiguous: the request was received (HTTP 200)
   and is known not to have finished; the free route has no side effects; partial text is kept.
5. **Parallel tools without overspend.** No reservation ledger exists (admission is a balance
   check), and adding holds would change settlement semantics. So billable and provider-backed
   tools stay sequential; only non-billable tools without `reconcile` run concurrently.
   Ordering is by call index; settlement stays per invocation and exactly-once.
6. **Thinking duration is timing only** (`Message.thinkingMs`); reasoning is never requested,
   streamed, stored or rendered.

## Not done / known limits
- A worker that crashes while WAITING is not resumed: re-entry treats the stale pending
  message as ambiguous (existing behavior); the sweep later expires its waitpoint.
- Only the PLAN waitpoint type has a caller; APPROVAL/CREDIT/MEDIA are registry entries away.
- Interrupting during a billable tool call stops the run; the in-flight Magica run is left to
  the existing reconciliation/settlement recovery (never restarted).
