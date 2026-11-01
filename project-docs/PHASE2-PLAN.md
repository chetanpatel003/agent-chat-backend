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

> **Status: done.** Implemented as designed above, with one refinement
> decision C's own text made more precise mid-implementation: the
> PENDING message is *preserved*, never flipped to FAILED, on an
> ambiguous outcome — only the AgentRun transitions. Two real live
> OpenRouter calls (free, cost 0) grounded the adapter's response-shape
> handling rather than guessing from docs that don't document whether
> `model` reflects actual routing or whether `content` can be null — see
> decisions/0010. Time actually spent: see the checkpoint 2.2 completion
> report for the honest breakdown against this 3h estimate.

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

> **Status: done.** Delivered scope expanded beyond this section's own
> text, per more detailed follow-up instructions received when this
> checkpoint started (overriding the trim above and this plan's original
> "cancellation funnels into the ambiguous-outcome path" framing):
> - Every AgentRun status write is now a guarded CAS
>   (`src/services/run-transitions.ts`), not a plain `update()` — not
>   originally scoped at this granularity, added because cancellation
>   needs a race-safe way to coexist with the worker's own writes.
> - Terminal Message+Chat+AgentRun writes are atomic `$transaction`s,
>   each guarded by the message still being PENDING.
> - A new partial unique index (`Message_one_assistant_per_run`,
>   DATABASE.md) makes "one assistant message per run" database-enforced
>   and doubles as the real mutex for two genuinely concurrent
>   `executeAgentTurn()` calls — proven with an actual `Promise.all` race,
>   not just reasoned about.
> - Cancellation (`POST .../runs/[runId]/cancel`, `src/services/agent-run.ts#cancelRun`)
>   ends in `CANCELLED`, a distinct outcome from `AMBIGUOUS_PROVIDER_OUTCOME`
>   — not funneled into the ambiguous path as originally planned, since a
>   cancel is a *known*, deliberate transition, not an unknown outcome.
>   AbortSignal was investigated and found unavailable for a plain
>   `task({run})`'s context in the installed SDK (verified by reading
>   `TaskRunContext`'s schema directly); cancellation is instead caught
>   by guarded status reads before/after the provider call and before
>   each tool call, not by interrupting the in-flight request.
> - The RunEvent contract's `assistant_text` variant became
>   `assistant_message` (a pointer to `messageId`, never content), per
>   the same follow-up instructions, and the "no dedicated variant test"
>   trim above was reversed — `run-event.test.ts` tests every variant
>   plus an explicit "content field rejected" case (`z.strictObject()`,
>   not silent stripping).
> - Additional tests beyond the three originally named: publish-after-
>   commit (a spy that reads the DB inside its own callback), publisher-
>   failure isolation (sync-throw and async-reject), and terminal-state
>   protection extended to FAILED/CANCELLED, not just COMPLETED.
> - The concurrency test itself surfaced a real, narrow race (a "losing"
>   execution can mark the run ambiguous based on the "winner's"
>   legitimately in-progress message) — documented as an accepted
>   trade-off in API_CONTRACTS.md rather than fixed, since a real fix
>   needs genuine liveness information this design doesn't have, and
>   Trigger.dev's own idempotency means it essentially can't happen
>   between separate real dispatches.
> - One cancellation test ("provider call active") is intermittently
>   flaky in this environment — confirmed via direct, timestamped
>   diagnostics that the underlying code computes the exactly-correct
>   result; the flakiness traces to Neon connection/latency variance
>   under this session's many consecutive full-suite runs (an unrelated,
>   untouched checkpoint-1.3 test timed out in the same run as
>   independent evidence), not a logic defect. See the completion
>   report for the exact pass/fail state at time of reporting.
> Time actually spent: see the checkpoint 2.4 completion report for the
> honest breakdown against this 2.5h estimate — expanded scope took
> longer than the original text alone would have.

**2.5 — Final verification + docs**
Full test/typecheck/lint/build both repos; DATABASE.md (confirms no
migration), API_CONTRACTS.md, TOOL_REGISTRY.md ("mechanism implemented,
zero real tools"), ARCHITECTURE.md, a decisions/ entry recording this
plan's A/B/C resolutions. Lighter than a from-scratch writeup since this
plan document already carries most of the content.
**1h.**

> **Status: superseded, not "done" as originally scoped above.** A
> full, separate, much more detailed instruction document — "Phase 2.5
> — Application-Owned Skills System" — replaced this section's own
> framing entirely before this checkpoint started, the same override
> pattern checkpoint 2.4 received. What was actually delivered:
> - **Decision A amended, narrowly.** `PRODUCTION_TOOL_REGISTRY` is no
>   longer empty — it holds exactly two tools, `load_skill` and
>   `read_skill_asset` (`src/tools/skills.ts`), both local-only (no
>   provider call, no credit charge). Magica/business tools are still
>   deferred to Phase 3; this is not a general reopening.
> - A new `RunSkill` model and migration (`20261101135129_add_run_skill`)
>   — the `RunSkill (skills durability)` deferral named in the schema's
>   own header comment since checkpoint 1.1 (decisions/0006) is now
>   resolved.
> - An application-owned `agent-skills/` directory with three real,
>   non-placeholder skills, a discovery/validation registry
>   (`src/skills/registry.ts`) that fails loudly and aggregates every
>   problem rather than silently skipping a bad bundle, and a path-
>   security layer (`src/skills/paths.ts`) that resolves assets through
>   a pre-vetted map lookup plus a read-time realpath re-check, never a
>   raw `path.resolve()` on untrusted tool input.
> - `executeAgentTurn` gained a fourth DI parameter (`skillRegistry`,
>   same pattern as `registry`/`publish`) and now prepends a synthesized
>   skill-metadata system prompt to `history` — no new orchestration
>   branch for skills.
> - A genuine design finding during implementation, verified rather
>   than assumed: the P2002 error shape documented in decisions/0009 for
>   a hand-added raw-SQL *partial* index (`driverAdapterError.cause.
>   constraint.index`, never the naive `{ target: [...] }` shape) turned
>   out to apply identically to this checkpoint's *normal*,
>   schema-declared composite unique constraint — confirmed with a
>   standalone diagnostic script against the real database, not guessed
>   from the prior case.
> - One of this document's own draft design choices (requiring a
>   skill's frontmatter `name` to equal its directory name) was reversed
>   mid-implementation: it made the explicitly-required "reject
>   duplicate skill names across different directories" behavior
>   structurally unreachable (two sibling directories can never share a
>   name), so the check was dropped rather than kept as dead weight.
> Full detail: API_CONTRACTS.md's "Application-owned skills system"
> section, DATABASE.md's checkpoint 2.5 entry, and the checkpoint 2.5
> completion report for exact test counts.

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

## Checkpoint 3.1 — Execution Framework Hardening

> **Status: done.** A dedicated hardening pass on the tool-calling
> execution framework before Magica integration, per its own separate
> instruction document (not part of this plan's original §6 sequence).
> Continued from the repo's actual current state (checkpoint 2.4
> committed as `aa5fdc4`, checkpoint 2.5 staged on top) rather than
> reverting to committed `main` alone — the hardening targets (the tool
> loop, concurrency, retry) are inherited unchanged in substance from
> 2.4; 2.5's own changes to `run-agent-turn.ts` were orthogonal (a 4th
> DI parameter, one prepended system message) and untouched here.
>
> Five areas, each investigated against the real current code first
> (not the prior reports describing it):
> 1. **Max-round boundary** — the Phase 3 prerequisite named since 2.4
>    (a last-round `tool_calls` response was still executed even though
>    its result could never reach the model) is now fixed:
>    `recordTurnLimitCancellation` records each such call `CANCELLED`
>    instead, never executing it, never silently dropping it.
> 2. **Tool-call validation** — found a real gap via code inspection,
>    not just reasoning: two `tool_calls` sharing one `id` in a provider
>    response would have crashed via an unhandled P2002 on
>    `ToolInvocation.idempotencyKey`. Fixed at response-validation time
>    in `openrouter.ts` (reuses the existing `MALFORMED_RESPONSE` path).
> 3. **Invocation lifecycle** — `runOneToolCall`'s execution and
>    persistence were previously one try/catch; a persistence failure
>    after a successful execution risked a second write attempt
>    mischaracterizing it. Now strictly separated, exactly one
>    `toolInvocation.update()` call on every path.
> 4. **Retry/idempotency** — investigated and found already correct by
>    design; documented explicitly (the three crash windows) rather
>    than rebuilt. No generic framework introduced, per the brief's own
>    instruction.
> 5. **The concurrency race** — re-investigated per the brief's explicit
>    instruction not to assume Trigger.dev idempotency makes it
>    impossible without evidence. Confirmed again, deterministically,
>    then fixed with `isAgentRunRecentlyActive` (reuses the existing
>    `AgentRun.updatedAt` write already happening every round as a
>    liveness signal — no heartbeat table, no lease, no new
>    abstraction). The race-reproduction test now resolves
>    deterministically instead of "either outcome, both safe."
>
> Full mechanism and before/after behavior: API_CONTRACTS.md. Exact
> test results: TEST_STATUS.md and the checkpoint 3.1 completion
> report. Staged, not committed, per standing instruction.
