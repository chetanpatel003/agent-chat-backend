# PROJECT_STATE — backend

Full chronological narrative: `~/Desktop/chat/progress.md` (workspace-level, outside this repo, **not currently git-tracked** — flagged for user decision: copy into a repo for durability, or leave local-only since it's working notes, not a deliverable).

## Day / hour
Day 1 of 3. **Phase 1 complete** — all 4 checkpoints done in both repos.

## Environment — verified working
Neon Postgres (pooled+direct), Clerk, Trigger.dev (CLI logged in, project initialized), OpenRouter (free tier, $0 used), Magica (balance 30,000,000 raw units). Not yet set: Transloadit (deferred to day 3).

## Implemented
- **Checkpoint 1.1 (database foundation): done and verified.** `prisma/schema.prisma` has the 9 required models; migration applied to Neon. See DATABASE.md.
- **Checkpoint 1.2 (auth + contracts): done and verified.** Clerk bearer-token auth (`src/services/auth.ts`), ownership checks for all 6 resource types (`src/services/ownership.ts`), full Zod contract set (`src/contracts/`), one real route (`GET /api/v1/me`), CORS. 27/27 tests passing, real HTTP smoke test against the dev server confirms live Clerk verification works. See API_CONTRACTS.md and decisions/0007 for a real concurrency bug found and fixed along the way.
- **Checkpoint 1.3 (core backend APIs): done and verified.** Chat CRUD + search (`GET/POST /api/v1/chats`, `GET/PATCH/DELETE /api/v1/chats/[chatId]`), message history (`GET /api/v1/chats/[chatId]/messages`), credits read endpoints (`GET /api/v1/credits/balance`, `GET /api/v1/credits/ledger`) — all cursor-paginated, all ownership-enforced. `src/lib/route-handler.ts` (new shared wrapper) keeps every route thin. 63/63 tests passing (36 new), real HTTP smoke test confirms every new route — including the nested dynamic segment — resolves correctly. See API_CONTRACTS.md, decisions/0008 (deferred index), and the cursor-field rename noted there.
- **Checkpoint 1.4 (frontend integration + Phase 1 verification): done.** No backend code changes — this checkpoint's work was entirely in the frontend repo (service modules, query/mutation hooks, cache strategy, 19 new tests) plus a cross-repo review. Reviewed the two deferred opportunities from 1.3 (pinned-chat index, `content::text` search) — no new evidence of a concrete correctness/performance issue, both remain correctly deferred (decisions/0008 still stands). `pnpm build` (production) verified passing, in addition to test/typecheck/lint.
- **Checkpoint 2.1 (admission + durable dispatch skeleton): done and verified.** `POST /api/v1/chats/[chatId]/messages` (idempotent send, 409 on a concurrent active run), `GET /api/v1/chats/[chatId]/runs/active`, a stub `run-agent-turn` Trigger.dev task. **Risk 1 from PHASE2-PLAN.md resolved**: `pnpm trigger:dev` run for the first time this trial — a real dispatch completed end to end (QUEUED→RUNNING→COMPLETED), and Trigger.dev's own idempotency was confirmed live, not just from docs. 74/74 tests passing (11 new). See API_CONTRACTS.md, decisions/0009 (empirically verified P2002 branch condition).
- Not yet implemented: real OpenRouter call, tool execution, skills, Magica tools, uploads, realtime, waitpoints, credit charging, chat workspace UI — explicitly excluded through checkpoint 2.1.

## Current phase
**Phase 2, checkpoint 2.1 complete.** Plan in `project-docs/PHASE2-PLAN.md`. Awaiting approval for checkpoint 2.2 (real OpenRouter integration + the PENDING-marker ambiguous-outcome mechanism — this is where `decisions/0009`'s pattern and the stub task's re-entry guard both get exercised for real).

### Next task if resuming cold
1. Read this file + `PHASE2-PLAN.md` + `API_CONTRACTS.md` + decisions/0006–0009.
2. `git status` — checkpoint 2.1's changes are staged, not committed.
3. `pnpm test` to re-confirm 74/74 before building on top (a transient Neon-cold-start flake on the first run of a session is expected per decisions/0006 — rerun once before treating it as real).
4. Wait for checkpoint 2.2 instructions.

## Open questions (non-blocking for Phase 1, need answers before later phases)
1. Chat titles: auto-generated from first message, or user-named only?
2. Confirmed: no message editing, retry only (creates new AgentRun via `retryOfRunId`).
3. Attachment retention after Transloadit temp-URL expiry: re-host to S3-compatible storage, or document as known limitation?
4. Confirmed: soft delete only, no hard purge.
