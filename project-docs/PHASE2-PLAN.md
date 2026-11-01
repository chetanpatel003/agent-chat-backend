# Phase 2 — Agent Execution Engine: Plan (revised)

Planning only. No code written. This revision incorporates the user's
decisions A/B/C and additional requirements. Two technical claims below
were verified against the installed `@trigger.dev/sdk@4.8.3` /
`@trigger.dev/core@4.8.3` type definitions, not assumed:
- `.trigger(payload, { idempotencyKey, idempotencyKeyTTL })` is real —
  `idempotencyKey?: IdempotencyKey | string | string[]`,
  `idempotencyKeyTTL?: string` (duration string, e.g. `"24h"`; no default
  asserted here since the types don't state one — set it explicitly at
  implementation time). The SDK's own doc comment: *"If you are
  triggering a task from your backend, ensure you include some
  sufficiently unique key material"* — our `AgentRun.idempotencyKey`
  (already DB-unique) satisfies this.
- `metadata.set(key, value)` / `metadata.append(key, value)` are real,
  callable from inside a task's run context, and are Trigger.dev's own
  native Realtime mechanism — confirmed in `metadata.d.ts`.

## Decision A — Tool registration (confirmed)
Full typed registry and execution mechanism built and tested. One
deterministic fixture tool registered **in tests only**, never reachable
from a real conversation (the production registry array is empty in
Phase 2). Magica's three tools register into this same registry
unchanged in Phase 3 — the registry's shape doesn't change, only its
contents grow.

## Decision B — Realtime: backend architecture now, transport/UI later
Built in Phase 2, thin, no new infrastructure:
- **Typed run-event contract** (`contracts/run-event.ts`, new): a
  discriminated union — `run_status`, `assistant_text`, `tool_started`,
  `tool_completed`, `tool_failed`. Turn-level, not token-level (no
  streaming deltas — that's the later realtime checkpoint's concern).
- **Publishing interface**: one function, `publishRunEvent(event)`,
  implemented by calling Trigger.dev's own `metadata.append("events",
  event)` after validating against the contract. This *is* Trigger.dev
  Realtime — the tech the assessment names — not an event bus we're
  adding. Called from inside the task, always **after** the
  corresponding Postgres write commits, never before ("persist before
  emitting," already an existing rule in `.claude/rules/backend.md`).
- **REST reconciliation**: `GET .../runs/active`, already planned.
- **Not built now**: no frontend subscriber, no SSE/WebSocket client
  code, no reconnect logic — those need a real UI to be meaningful and
  are explicitly deferred to the realtime checkpoint.

## Decision C — Recovery correctness (revised design)

**The core fix, and why it needs no schema change:** `Message.status`
already has `PENDING` in its enum (confirmed by reading the live
schema). That value becomes the "an attempt was made, outcome unknown"
marker:

1. **Before calling OpenRouter**, insert the assistant `Message` row
   with `status: PENDING`, `content: []`. This commit *is* "persist the
   request/attempt state before making the call." `AgentRun.turnCount`
   increments in the same write.
2. **Call OpenRouter.**
3. **On a clear response** (success or a definite provider error like
   429): update that same Message row — `COMPLETE` with real content
   blocks, or `FAILED` — and update `AgentRun` accordingly. Never
   ambiguous; this is the common case.
4. **On a crash or hard timeout during the call**: nothing else happens
   in this execution. The Message row is left at `PENDING` — that's the
   durable, honest record of "we don't know what happened."
5. **On task re-entry** (retry, or a resumed run): before doing anything
   else, look for a `Message` row belonging to this `AgentRun` still at
   `PENDING`. Finding one means an attempt is ambiguous. **Do not
   retry it automatically.** Mark that Message `FAILED`, mark the
   `AgentRun` `FAILED` with `errorCode: "AMBIGUOUS_PROVIDER_OUTCOME"`
   and a clear, honest `errorMessage`. A human-initiated retry creates a
   **new** `AgentRun` (via the existing `retryOfRunId` self-relation) —
   a conscious new attempt, never a blind replay of the ambiguous one.
   OpenRouter/OpenAI-compatible chat completions have no verified
   request-level idempotency key of their own, so this surfaced-failure
   approach is used instead of an unverified exactly-once claim, per the
   instruction.
6. **Terminal states are never overwritten**: step 5's check runs
   *before* anything else; if `AgentRun.status` is already `COMPLETED`,
   `FAILED`, or `CANCELLED`, the task exits immediately. A late-arriving
   duplicate task execution (should be rare given Trigger.dev's own
   idempotencyKey, but not assumed to be impossible) can never flip a
   terminal run back to an earlier state.

**Tools, same pattern, already closer to correct in the existing
schema:**
- `ToolInvocation` is inserted at `PENDING` *before* execution (already
  the Phase 1 design intent, now made load-bearing).
- `providerRunId` is persisted the moment an external call returns one
  — for Phase 2's fixture tool there is no external call, so this path
  is designed but not exercised; Magica tools in Phase 3 populate it for
  real.
- **Reconciliation interface**: the registry's tool-handler type gets an
  optional `reconcile(invocation)` method. On task re-entry, a
  `ToolInvocation` still `RUNNING` for this run is checked: if its tool
  defines `reconcile`, call it (Magica tools will poll `providerRunId`
  here in Phase 3); if not, treat it the same as an ambiguous model
  call — mark `FAILED`, never blindly re-execute. The fixture tool
  doesn't define `reconcile` (it's synchronous and effectively can't be
  left mid-flight), so this falls through to the safe default, which is
  exactly what should happen until Phase 3 gives it something real to
  reconcile against.

## Additional requirements — where each is satisfied

| Requirement | How |
|---|---|
| Cancellation safe against a racing provider request | Cancellation is checked between loop iterations, never mid-call; a cancel arriving *during* an OpenRouter call leaves that Message at PENDING, caught by the same ambiguous-outcome path on the next check — cancellation and crash funnel into one mechanism, not two |
| Terminal states not overwritten by late completions | Step 6 above |
| Duplicate dispatch → no duplicate assistant messages | AgentRun-level idempotency (unique `idempotencyKey` + Trigger.dev's own `idempotencyKey`) means a retried dispatch never produces a second AgentRun/task; within one AgentRun, re-entry always checks for an existing PENDING/terminal state before writing anything new |
| Preserve partial output and completed tool results | Never rolled back — only the AgentRun's own status/error fields change on any failure path; every Message/ToolInvocation already committed stays committed |
| No schema change unless proven necessary | None proposed — §Database impact below |
| Phase 1 code untouched unless a real defect requires it | None found; nothing in this plan touches Phase 1 files |

## 1. Requirement mapping
(Unchanged from the prior draft — see git history of this file, or ask
and I'll reproduce it. Kept short here since the user already reviewed
it; nothing in it changed.)

## 2. Current-state audit
Unchanged core finding: `AgentRun`, `Message`, `ToolInvocation`,
`Waitpoint` already carry every field the revised design needs — the
`Message.status = PENDING` reuse (above) is itself evidence the schema
was already shaped correctly for this. Still missing, to be built:
`src/providers/openrouter.ts`, `src/tools/registry.ts`,
`src/realtime/events.ts` + publisher, `src/trigger/run-agent-turn.ts`,
`src/services/send-turn.ts`, the three new routes, and the
`AgentRunResponseSchema` / `SendMessageRequestSchema` /
`RunEventSchema` contracts.

## 3. Architecture (revised)

```
Client
  │ POST /chats/:id/messages  (Idempotency-Key header)
  ▼
Route (authenticate → requireChatOwnership → validate)
  ▼
send-turn service: ONE transaction
  - insert Message (role=USER)
  - insert AgentRun (status=QUEUED, idempotencyKey)
    → partial unique index rejects a 2nd active run (23505 → 409)
  ▼
commit, then: run-agent-turn.trigger(payload, {
    idempotencyKey: agentRun.idempotencyKey,   // verified real
    idempotencyKeyTTL: "24h",                  // set explicitly
  })
  → persist returned triggerRunId onto the AgentRun row
  ▼
202 { chatId, messageId, runId, triggerRunId }
  (client polls GET .../runs/active; later checkpoint adds realtime subscribe)

────────────────────────────────────────────────────────

Trigger.dev worker: run-agent-turn task
  1. load AgentRun
     - COMPLETED/FAILED/CANCELLED → exit (terminal states never reopened)
     - a Message or ToolInvocation for this run is still PENDING/RUNNING
       with no reconcile path → mark it + the run FAILED
       (errorCode=AMBIGUOUS_PROVIDER_OUTCOME), exit — never auto-retry
  2. mark RUNNING, set startedAt if unset; publishRunEvent(run_status)
  3. restore message history from Postgres (bounded)
  4. loop (turnCount < maxTurns):
       a. insert Message(PENDING, []), turnCount++         [commit]
       b. call OpenRouter (openrouter/free, tools=registry defs)
       c. clear response → update Message + AgentRun accordingly [commit]
          publishRunEvent(assistant_text | run_status)
       d. tool_calls present → for each:
            insert ToolInvocation(PENDING)                  [commit]
            publishRunEvent(tool_started)
            invalid args → FAILED + tool_result fed back     [commit]
            valid → RUNNING → execute → COMPLETED/FAILED     [commit]
            publishRunEvent(tool_completed | tool_failed)
          loop back to (a) with tool results appended
  5. terminal: persist status/completedAt/error fields        [commit]
     publishRunEvent(run_status)
```

Every lettered step that says `[commit]` happens before the next
external call. That ordering is the entire mechanism — nothing else
makes recovery correct.

## 4. Database impact
**Still none.** The `Message.status = PENDING` reuse is precisely why —
the field already existed for exactly this purpose, it just hadn't been
pressed into service yet.

## 5. API contracts (minimum, revised)

| Endpoint | Method | Contract |
|---|---|---|
| `/api/v1/chats/[chatId]/messages` | POST | `SendMessageRequestSchema` in → `SendMessageResponseSchema` (`{chatId, messageId, runId, triggerRunId}`) out, 202 |
| `/api/v1/chats/[chatId]/runs/active` | GET | → `AgentRunResponseSchema \| null` |
| `/api/v1/chats/[chatId]/runs/[runId]/cancel` | POST | → `AgentRunResponseSchema` |

New: `contracts/run-event.ts` — `RunEventSchema` (discriminated union,
§Decision B). Backend-internal for now (published into Trigger.dev
metadata, not yet synced to the frontend — nothing there consumes it
until the realtime checkpoint).

`AgentRunResponseSchema` gains nothing beyond what was already planned;
still a direct mirror of the AgentRun row.

## 6. Execution sequence — retargeted to ~10h, with an honest critical path

I built the detailed algorithm above *during this planning pass*, which
should make implementation faster than a cold-start estimate — most of
the thinking that normally happens mid-checkpoint already happened here.
Even so, a faithful ~10h is tight against everything decision C asks
for. Below is the real critical path (cannot be cut without violating a
named non-negotiable requirement) versus what's trimmed to hit the
target, stated plainly rather than silently dropped.

**2.1 — Admission + durable dispatch skeleton** *(critical path)*
Contracts; `POST .../messages` transaction with idempotent dispatch and
the 409 conflict path; `GET .../runs/active`; a stub task proving
`pnpm trigger:dev` works in this environment before real logic depends
on it. Tests: duplicate-Idempotency-Key → one run, 409 on concurrent
send, ownership, task completes in dev mode.
**2.5h.**

**2.2 — Real OpenRouter + the PENDING-marker/ambiguous-outcome mechanism** *(critical path — this is decision C's core)*
The adapter (hard-asserts `openrouter/free`, captures real routed model
+ usage); the write-before-call sequencing from §3 steps 4a-4c; the
re-entry ambiguous-outcome check from §3 step 1. Tests: MSW-mocked
success/429/empty/malformed; a genuine simulated-crash test (force an
error *after* the PENDING insert, *before* the response update, then
re-invoke and assert `AMBIGUOUS_PROVIDER_OUTCOME`, not a silent retry).
**3h.**

**2.3 — Tool-calling mechanism, fixture-only** *(critical path, per decision A)*
Registry, Zod validation boundary, execute/persist/feed-back loop,
turn-limit bound. The `reconcile()` interface is defined on the handler
type (so Phase 3 has a real contract to implement against) but gets a
signature-level test only, not a full dormant-path test suite — nothing
in Phase 2 can genuinely exercise "reconcile an in-flight external call"
without a real async tool, so a deep test here would be testing against
an imagined scenario, not a real one. **This is the one deliberate trim
beyond decision A's own scope.**
Tests: fixture tool round-trip, malformed args, unknown tool name,
turn-limit-exceeded.
**2.5h.**

**2.4 — Realtime contract/publisher (thin) + the remaining non-cuttable reliability properties** *(critical path for the 3 items marked; realtime publisher is decision B's minimum, not trimmable either — it's explicitly "must establish," not optional)*
`run-event.ts` contract; `publishRunEvent()` wired at the 5 points in
§3's diagram. Reliability tests — three, matching the three
"Additional requirements" that have no other coverage: terminal-state-
not-overwritten (a completed run + a stale duplicate task invocation →
state unchanged), duplicate-dispatch-no-duplicate-message (same
Idempotency-Key sent twice for real through the route, not just at the
DB layer), cancellation-during-an-active-call (cancel arrives mid-
OpenRouter-call → same ambiguous-outcome path, not a hang).
**Trimmed:** no dedicated test for every individual RunEvent variant
(the contract's own Zod tests cover shape; the task tests already
exercise the call sites) — proportionate given decision B's "keep it
simple."
**2.5h.**

**2.5 — Final verification + docs**
Full test/typecheck/lint/build both repos; DATABASE.md (confirms no
migration), API_CONTRACTS.md, TOOL_REGISTRY.md ("mechanism implemented,
zero real tools"), ARCHITECTURE.md, a decisions/ entry recording this
plan's A/B/C resolutions. Lighter than a from-scratch writeup since this
plan document already carries most of the content.
**1h.**

**Total: ~11.5h.** Half an hour over the 10h target, entirely accounted
for by 2.2 and 2.4's crash/cancellation tests — the two tests that most
directly prove decision C's correctness requirement rather than just
asserting it in a comment. If 10h is a hard ceiling rather than a
target, the honest place to cut further is the cancellation-during-call
test in 2.4 (saves ~30-40min) — I'd flag that specific trade-off at the
time rather than cut it silently, since it's one of the three items
named directly in "Additional requirements."

## 7. Failure handling
Superseded by §Decision C and §3 above — the table from the prior draft
undersold the ambiguous-outcome case; the design above is the accurate
version.

## 8. Acceptance tests mapped to requirements

| Requirement | Test (checkpoint) |
|---|---|
| One active run per chat | 2.1: concurrent-send 409 |
| Idempotent dispatch | 2.1: duplicate Idempotency-Key → one run; 2.4: same, exercised through the real route end-to-end |
| Actual routed model recorded | 2.2: adapter asserts `AgentRun.model` is the response's real model |
| No paid fallback | 2.2: adapter refuses/throws if `OPENROUTER_MODEL` isn't `openrouter/free` |
| Bounded turns | 2.3: turn-limit-exceeded |
| Malformed tool calls handled | 2.3: bad args, unknown tool name |
| Crash/timeout → no blind retry of an ambiguous call | 2.2: the simulated-crash test — this is the one that actually proves decision C, not just the design doc |
| Terminal states never overwritten | 2.4 |
| Cancellation safe against a racing call | 2.4 |
| Realtime: typed events, persist-before-publish | 2.4 (structural — publisher only called after each commit, verified by call-order assertions in the task tests) |

## 9. Risks (unchanged from the prior draft, still the real top 3)
1. Trigger.dev dev-mode unverified in this environment — 2.1 proves it
   first, deliberately, before anything depends on it.
2. OpenRouter free-tier flakiness — tested via MSW, real calls reserved
   for acceptance evidence.
3. Crash-recovery correctness is easy to test shallowly — 2.2 and 2.4's
   tests force a failure *after* partial persistence, not just a clean
   re-read, the same rigor that caught the real upsert bug in
   decisions/0007.

## 10. Constraint compliance
No code written. Both verified SDK claims are cited with their source.
No schema change. No Phase 1 file touched. No event bus — Trigger.dev's
own metadata API is the entire "publishing interface." The one scope
trim beyond what was explicitly asked (§6, checkpoint 2.3's `reconcile`
test depth) is named plainly, not hidden in an estimate.
