# PROJECT_STATE — backend

Full chronological narrative: `~/Desktop/chat/progress.md` (workspace-level, outside this repo, **not currently git-tracked** — flagged for user decision: copy into a repo for durability, or leave local-only since it's working notes, not a deliverable).

## Day / hour
Day 1 of 3. Setup phase complete (~1–2h spent). Phase 1 (below) proposed, not yet approved.

## Environment — verified working
Neon Postgres (pooled+direct), Clerk, Trigger.dev (CLI logged in, project initialized), OpenRouter (free tier, $0 used), Magica (balance 30,000,000 raw units). Not yet set: Transloadit (deferred to day 3).

## Implemented
**Checkpoint 1.1 (database foundation): done and verified.** `prisma/schema.prisma` has the 9 required models; migration applied to Neon; Prisma client generated to `src/generated/prisma`. See DATABASE.md for the applied state. No application code yet (no route handlers, services, auth, Trigger.dev tasks) — checkpoint 1.1's stop condition explicitly excludes this.

## Current phase
Checkpoint 1.1 complete. Phase 1 has 3 more checkpoints (not yet specified by the user). Awaiting checkpoint 1.2 instructions.

## Next task if resuming cold
1. Read this file + MASTER.md + DATABASE.md + decisions/0006.
2. `git status` + `git log --oneline` to confirm nothing changed since (note: schema/migration files are staged, not committed, as of checkpoint 1.1 — confirm with user before committing).
3. `pnpm prisma migrate status` to re-confirm DB state matches this doc (if it fails with P1001, see decisions/0006 — likely just a cold Neon compute; retry, or verify directly via `pg`).
4. Wait for checkpoint 1.2 instructions before writing auth/API code — checkpoint 1.1's stop condition is explicit about this.

## Open questions (non-blocking for Phase 1, need answers before later phases)
1. Chat titles: auto-generated from first message, or user-named only?
2. Confirmed: no message editing, retry only (creates new AgentRun via `retryOfRunId`).
3. Attachment retention after Transloadit temp-URL expiry: re-host to S3-compatible storage, or document as known limitation?
4. Confirmed: soft delete only, no hard purge.
