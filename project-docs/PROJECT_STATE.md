# PROJECT_STATE — backend

Full chronological narrative: `~/Desktop/chat/progress.md` (workspace-level, outside this repo, **not currently git-tracked** — flagged for user decision: copy into a repo for durability, or leave local-only since it's working notes, not a deliverable).

## Day / hour
Day 1 of 3. Checkpoints 1.1 and 1.2 of Phase 1 (4 checkpoints) complete.

## Environment — verified working
Neon Postgres (pooled+direct), Clerk, Trigger.dev (CLI logged in, project initialized), OpenRouter (free tier, $0 used), Magica (balance 30,000,000 raw units). Not yet set: Transloadit (deferred to day 3).

## Implemented
- **Checkpoint 1.1 (database foundation): done and verified.** `prisma/schema.prisma` has the 9 required models; migration applied to Neon. See DATABASE.md.
- **Checkpoint 1.2 (auth + contracts): done and verified.** Clerk bearer-token auth (`src/services/auth.ts`), ownership checks for all 6 resource types (`src/services/ownership.ts`), full Zod contract set (`src/contracts/`), one real route (`GET /api/v1/me`), CORS. 27/27 tests passing, real HTTP smoke test against the dev server confirms live Clerk verification works. See API_CONTRACTS.md and decisions/0007 for a real concurrency bug found and fixed along the way.
- Not yet implemented: Chat/Message CRUD, credits, OpenRouter, Trigger.dev execution, skills, Magica tools, uploads, realtime, waitpoints — explicitly excluded from checkpoint 1.2's scope.

## Current phase
Checkpoints 1.1 and 1.2 complete. Phase 1 has 2 more checkpoints (1.3, 1.4 — not yet specified). Awaiting checkpoint 1.3 instructions.

## Next task if resuming cold
1. Read this file + MASTER.md + DATABASE.md + API_CONTRACTS.md + decisions/0006, 0007.
2. `git status` + `git log --oneline` — confirm nothing changed since. Checkpoint 1.2's changes are staged, not committed (same as 1.1 was until the user said to commit).
3. `pnpm prisma migrate status` to re-confirm DB state (if P1001, see decisions/0006 — likely cold Neon compute).
4. `pnpm test` to re-confirm 27/27 still pass before building on top.
5. Wait for checkpoint 1.3 instructions.

## Open questions (non-blocking for Phase 1, need answers before later phases)
1. Chat titles: auto-generated from first message, or user-named only?
2. Confirmed: no message editing, retry only (creates new AgentRun via `retryOfRunId`).
3. Attachment retention after Transloadit temp-URL expiry: re-host to S3-compatible storage, or document as known limitation?
4. Confirmed: soft delete only, no hard purge.
