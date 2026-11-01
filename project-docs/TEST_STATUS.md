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

Update this table (don't narrate) after each phase's test step.
