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
- Not yet implemented: message sending, OpenRouter, Trigger.dev execution, skills, Magica tools, uploads, realtime, waitpoints, credit charging, chat workspace UI — explicitly excluded through Phase 1.

## Current phase
**Phase 1 complete (checkpoints 1.1–1.4).** Awaiting Phase 2 instructions (or a go-ahead to start chat UI / agent execution).

## Next task if resuming cold
1. Read this file + MASTER.md + DATABASE.md + API_CONTRACTS.md + decisions/0006, 0007, 0008.
2. `git status` + `git log --oneline` — confirm nothing changed since. Backend has no uncommitted changes from checkpoint 1.4 (frontend-only); check the frontend repo separately.
3. `pnpm prisma migrate status` to re-confirm DB state (if P1001, see decisions/0006 — likely cold Neon compute).
4. `pnpm test` to re-confirm 63/63 still pass before building on top.
5. Wait for Phase 2 instructions.

## Open questions (non-blocking for Phase 1, need answers before later phases)
1. Chat titles: auto-generated from first message, or user-named only?
2. Confirmed: no message editing, retry only (creates new AgentRun via `retryOfRunId`).
3. Attachment retention after Transloadit temp-URL expiry: re-host to S3-compatible storage, or document as known limitation?
4. Confirmed: soft delete only, no hard purge.
