# TEST_STATUS — actual results

| Check | Last run | Result |
|---|---|---|
| `pnpm typecheck` | checkpoint 1.1 | PASS |
| `pnpm lint` | checkpoint 1.1 | PASS (no issues) |
| `pnpm test` (Vitest) | checkpoint 1.1 | FAIL — "No test files found" (expected, none written yet) |
| `prisma validate` | checkpoint 1.1 | PASS |
| `prisma migrate status` | checkpoint 1.1 | PASS — "Database schema is up to date" |
| Functional: one-active-run-per-chat constraint | checkpoint 1.1 | PASS — duplicate active run rejected (23505), terminal+active coexist, verified then rolled back |
| `pnpm typecheck` | checkpoint 1.2 | PASS |
| `pnpm lint` | checkpoint 1.2 | PASS (no issues) |
| `pnpm test` (Vitest) | checkpoint 1.2 | **PASS — 27/27** (5 files: contracts message/pagination, services auth/ownership, route /me) |
| Real HTTP smoke test (dev server) | checkpoint 1.2 | PASS — `/api/v1/me` 401 with no token and with a real-but-invalid token (live Clerk verification, not mocked); CORS preflight returns the configured `FRONTEND_ORIGIN` |

**Coverage by checkpoint 1.2's required test list:** missing token ✓, invalid token ✓, valid authenticated user ✓, existing local user lookup ✓, local user creation ✓, concurrent local user resolution ✓ (caught a real bug — see decisions/0007), frontend-supplied user id ignored ✓, cross-user chat ownership rejection ✓, invalid Zod payloads ✓ (content blocks + pagination), valid/invalid pagination cursors ✓, message content-block validation ✓.

| `pnpm typecheck` | checkpoint 1.3 | PASS |
| `pnpm lint` | checkpoint 1.3 | PASS (no issues) |
| `pnpm test` (Vitest) | checkpoint 1.3 | **PASS — 63/63** (10 files: +5 new — services chat/message/credits, routes chats/[chatId]) |
| Real HTTP smoke test (dev server) | checkpoint 1.3 | PASS — all 7 new routes resolve correctly (401 with no token, not 404), including the nested dynamic segment `/chats/[chatId]/messages` |

**Coverage by checkpoint 1.3's required test list:**
- Chat: create ✓, list ✓, deterministic pagination ✓ (explicit tie-timestamp test + no-gaps/no-duplicates across pages), retrieve ✓, update title ✓, pin/unpin ✓, soft-delete ✓, deleted-chat retrieval ✓ (404, same as owner.ts pattern), search titles ✓, search messages ✓, cross-user access rejection ✓ (service-level + one route-level test proving identical 404 body for "someone else's" vs "never existed").
- Messages: first page ✓, older-page cursor ✓, stable ordering on a real timestamp tie ✓, empty history ✓, cross-user access rejection ✓, invalid cursor ✓.
- Credits: balance retrieval ✓ (no-account=0, real account, cross-user isolation), ledger pagination ✓, cross-user access rejection ✓ (isolation, since there's no separate resource id to probe).
- General: missing/invalid auth ✓, invalid request parameters ✓ (out-of-range limit, empty-string title), consistent error responses ✓, no sensitive internals leaked ✓ (asserted no stack-trace pattern in two response bodies).

| `pnpm typecheck` | checkpoint 2.1 | PASS |
| `pnpm lint` | checkpoint 2.1 | PASS (no issues) — caught and fixed Trigger.dev's `.trigger/` dev-build output being linted as source (1560 false-positive problems); now excluded in `eslint.config.mjs`, already gitignored |
| `pnpm test` (Vitest) | checkpoint 2.1 | **PASS — 74/74** (13 files: +3 new — services send-turn/agent-run, route-level send test). One transient Neon-cold-start flake on first run (decisions/0006), passed clean on rerun. |
| `pnpm build` (production) | checkpoint 2.1 | PASS — `/api/v1/chats/[chatId]/messages` (POST) and `/api/v1/chats/[chatId]/runs/active` (GET) both registered correctly |
| Real Trigger.dev dev-worker run | checkpoint 2.1 | **PASS — the actual, non-mocked pipeline.** `pnpm trigger:dev` run for the first time this trial; a real dispatch via `sendTurn()` produced a real `triggerRunId`, the task transitioned QUEUED→RUNNING→COMPLETED on its own, the stub assistant message and `Chat.lastMessageAt` persisted correctly, and a second `.trigger()` call with the same idempotency key returned the identical run id — Trigger.dev's own idempotency confirmed for real, not just from its docs. |

**Precondition for a full green run:** `pnpm trigger:dev` must be running
in a separate terminal — `send-turn.test.ts`'s happy-path test dispatches
a real task and waits for the real dev worker. Without it, that one test
times out after 20s rather than failing fast; every other test is
unaffected. (Found this the hard way mid-checkpoint: stopped the worker
for a `pnpm build` check, reran `pnpm test` without restarting it —
confirmed it was exactly that, not a regression, by restarting the
worker and getting 74/74 clean again.)

**Coverage by checkpoint 2.1's test list:** admission transaction ✓, duplicate-send idempotency ✓ (same Idempotency-Key twice → one run, identical response, both at the service layer and through the real route), one-active-run 409 ✓, cross-user rejection ✓, invalid body ✓ (empty text, missing header), task completes in dev mode ✓ (the real end-to-end run above, plus an automated test waiting on the same real worker), status read-back ✓ (`GET .../runs/active`).

| `pnpm typecheck` | checkpoint 2.2 | PASS |
| `pnpm lint` | checkpoint 2.2 | PASS (no issues) |
| `pnpm test` (Vitest) | checkpoint 2.2 | **PASS — 92/92** (17 files: +4 new — openrouter adapter, conversation-context, run-agent-turn orchestration, send-turn.transactional) |
| `pnpm build` (production) | checkpoint 2.2 | PASS |
| Live OpenRouter connectivity | checkpoint 2.2 | **2 real, controlled calls** (free tier, `cost: 0` confirmed in each response) — made during design, not as part of the automated suite. Found that `model` genuinely varies per call and `content` can be `null` with the real output in `reasoning` instead. Full detail: decisions/0010. |
| Real Trigger.dev + real OpenRouter, end to end | checkpoint 2.2 | **PASS**, repeatedly — `send-turn.test.ts`'s happy path dispatches through the real route → real task → real `openrouter/free` call → real completion, every suite run, with zero duplicate dispatches or orphaned provider calls after the fix below. |

**A real issue found and fixed mid-checkpoint, not just noted:** once the
task made a real OpenRouter call, checkpoint 2.1's `send.test.ts`
(route-level) and the "idempotent" case in `send-turn.test.ts` *also*
triggered real background dispatches as an unintended side effect of
testing HTTP/transactional behavior — each test's own cleanup then
hard-deleted the rows before Trigger.dev's async retries could finish,
leaving orphaned `Error (retrying...)` entries in Trigger.dev's
dashboard and burning real (if free) API quota on every test run. Fixed
by mocking `runAgentTurn.trigger` in those specific tests (a `vi.spyOn`
on the Trigger.dev task object was tried first and did not actually
intercept the call — confirmed empirically, not assumed — so a full
module mock was used instead, split into `send-turn.transactional.test.ts`).
Verified via the worker's own log: exactly one real dispatch per full
suite run afterward, every one a clean `Success`, zero retries.

**Coverage by checkpoint 2.2's test list:** successful response (PENDING→COMPLETE, content persisted, actual model recorded) ✓, definite provider failure (message FAILED, run FAILED, safe error code) ✓, simulated crash after dispatch — re-entry finds the PENDING message, **zero second provider calls** (the one guarantee that actually matters, asserted directly via mock call count), run marked `AMBIGUOUS_PROVIDER_OUTCOME`, message preserved at PENDING, not flipped to FAILED ✓, timeout/network ambiguity does not trigger an automatic retry ✓ (same mechanism as the crash test, verified for a fresh in-call failure too, not only re-entry), duplicate task dispatch — no duplicate message, provider not called twice ✓, paid/unsupported model configuration rejected with zero requests made ✓ (asserted no HTTP call occurred), malformed provider response — boundary validation, safe failure, no crash ✓.

| `pnpm typecheck` | checkpoint 2.3 | PASS |
| `pnpm lint` | checkpoint 2.3 | PASS (no issues) |
| `pnpm test` (Vitest) | checkpoint 2.3 | **PASS — 114/114** (+22 new — tools/registry, openrouter tool-calling parsing, run-agent-turn tool-calling/reconcile/turn-limit) |
| `pnpm build` (production) | checkpoint 2.3 | PASS — no route changes (backend-internal checkpoint); routes unchanged from 2.2 |
| Real Trigger.dev + real OpenRouter, end to end | checkpoint 2.3 | **PASS**, unchanged — `send-turn.test.ts`'s happy path still dispatches through the real route/task/`openrouter/free` call. The production registry is empty (Decision A), so this real path never sends `tools` or exercises tool-calling — confirmed by `openrouter.ts` omitting the `tools` key entirely when the registry is empty, not just by not testing it. |
| Live OpenRouter tool-calling connectivity | checkpoint 2.3 | **Deliberately none.** Doing so would mean exposing a tool to a real conversation, which this checkpoint's scope explicitly excludes. The request/response shapes are taken from OpenRouter's documented schema instead — decisions/0011. First real exercise is Phase 3. |

**Coverage by checkpoint 2.3's required test list** (fixture tool
round-trip, invalid input, duplicate invocation, failures, persistence —
per the approval message; malformed args, unknown tool name, turn-limit-
exceeded — per PHASE2-PLAN.md):
- **Round-trip** ✓: validates → persists `RUNNING` before `execute()` →
  executes → persists `COMPLETED` + output → feeds the result back →
  reaches a final answer in a second model call. Also verifies narration
  text accompanying a tool call is captured, not just the final answer.
- **Invalid input** ✓ (fails the tool's own Zod schema) and **malformed
  arguments** ✓ (not valid JSON) — both proven to never call `execute()`
  (asserted via a spy), both still produce an auditable `FAILED`
  `ToolInvocation`, both let the loop continue to a final answer rather
  than crashing the turn.
- **Unknown tool name** ✓ — a model-hallucinated tool call still
  produces a real, auditable `FAILED` invocation (`errorCode:
  "UNKNOWN_TOOL"`) instead of crashing.
- **Failures** ✓ — `execute()` throwing is recorded `FAILED` with the
  real error message and `durationMs`, and the loop continues.
- **Duplicate invocation** ✓, two angles: orchestration-level (a second
  `executeAgentTurn` call after a tool-calling run `COMPLETED` does not
  re-execute the tool — asserted via spy call count and invocation
  count) and schema-level (`ToolInvocation.idempotencyKey`'s unique
  constraint rejects a direct duplicate insert — `P2002`, asserted
  directly, not just trusted from the schema).
- **Persistence** ✓ — every `ToolInvocation` field (`status`, `toolName`,
  `output`, `durationMs`) and every `tool_use`/`tool_result` content
  block pair checked directly against the database, not inferred.
- **Turn-limit-exceeded** ✓ — a model that never stops requesting tools
  is bounded at `MAX_TURNS = 8`: run `FAILED`/`TURN_LIMIT_EXCEEDED`,
  exactly 8 provider calls, partial content (16 tool_use/tool_result
  blocks, no final text) preserved rather than discarded.
- **`reconcile()`, signature-level** ✓ (per PHASE2-PLAN.md's explicit
  scope trim — "not a full dormant-path test suite"): re-entry onto a
  `RUNNING` `ToolInvocation` whose tool has no `reconcile()` never calls
  `execute()` and marks the run ambiguous; a tool that *does* define
  `reconcile()` gets it called on re-entry instead (asserted via spy),
  `execute()` still never called, and the `ToolInvocation` itself is
  left `RUNNING` as evidence in both cases, same principle as the
  message-level `PENDING` marker.
- **Backward compatibility** ✓ — all 92 pre-2.3 tests pass unchanged;
  the no-tools path (the only path in production, since the registry is
  empty) is a degenerate one-round case of the same loop, not a separate
  code path.

Update this table (don't narrate) after each phase's test step.
