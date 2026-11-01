# DATABASE — actual schema

**Status: applied and verified**, 2026-11-01. Full reasoning + every field: https://claude.ai/artifact/FUmAGRidGqSu1DWF9bmDxL (note: that doc also covers `RunSkill`, deferred — see decisions/0006).

## Applied
- Migration `20261101000001_checkpoint_1_1_database_foundation`, recorded in `_prisma_migrations` (checksum `eee58ec6…`), confirmed via `prisma migrate status`: "Database schema is up to date."
- 9 tables: User, CreditAccount, CreditLedger, Chat, Message, AgentRun, ToolInvocation, Waitpoint, Attachment.
- 16 foreign keys, 29 indexes total (PK + unique + composite).
- Partial unique index `AgentRun_one_active_per_chat` on `AgentRun(chatId)` WHERE status IN ('QUEUED','RUNNING','WAITING') — functionally verified: a second active run on the same chat is rejected (`23505`), a terminal-status run alongside an active one is allowed.
- Time-series tables use `uuid default uuidv7()` (native Postgres 18).
- `DateTime` fields are `timestamptz(6)`.

## Deferred (see decisions/0006)
- `RunSkill` table — not in checkpoint 1.1's required entity list.
- Full-text search index on `Chat.title`.

## Checkpoint 1.3 — no migration
Chat/message/credit APIs needed no schema change. One index opportunity
surfaced (pinned-chats ordering has no covering composite index) and was
deliberately **not** applied — queries are correct without it, just not
optimally indexed at scale. See decisions/0008.
`prisma.config.ts`'s runtime PrismaClient is now actually wired
(`src/lib/prisma.ts`, checkpoint 1.2) — the "not yet written" note below
is stale as of this checkpoint.

## Checkpoint 2.1 — no migration
`Message.status = PENDING` (already existed) is now load-bearing — it's
the "an attempt was made, outcome unknown" marker the whole crash-
recovery design in `PHASE2-PLAN.md` depends on. Confirms the schema was
shaped correctly for this before the field was ever used this way. Not
exercised yet (checkpoint 2.1 is a stub task with no real external call
to crash mid-flight) — checkpoint 2.2 is where this actually matters.

## Prisma CLI / Neon connectivity
`prisma migrate dev`/`deploy` initially failed (`P1001`) against a cold Neon compute; migration was generated via `migrate diff --from-empty --to-schema` (no DB connection) and applied directly via `pg`, recorded into `_prisma_migrations` to match what `deploy` would have produced. Once compute was warm, `prisma migrate status` succeeded normally and confirmed the same state. Full writeup: decisions/0006.

## Config note
`prisma.config.ts`'s `datasource.url` is CLI-only and points at `DIRECT_DATABASE_URL`. The app's runtime `PrismaClient` (not yet written) will use `@prisma/adapter-pg` with the pooled `DATABASE_URL` instead — Prisma 7 has no `directUrl` field in `prisma.config.ts`, unlike older `schema.prisma`-embedded config.
