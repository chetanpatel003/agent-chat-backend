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
shaped correctly for this before the field was ever used this way.

## Checkpoint 2.2 — no migration
The `PENDING`-marker mechanism above is now real and tested — confirmed
no schema change was needed to make it work (`run-agent-turn.test.ts`'s
crash-recovery test exercises it against the real schema). No other
field or table was needed for the real OpenRouter integration either —
`AgentRun.model`/`promptTokens`/`completionTokens`/`errorCode`/
`errorMessage`, all already present, are exactly what checkpoint 2.2
writes to.

## Checkpoint 2.3 — no migration
`ToolInvocation`'s existing columns (`idempotencyKey` unique, `status`,
`input`/`output` Json, `providerRunId`, `durationMs`, `errorCode`/
`errorMessage`) are now load-bearing for the first time — confirms the
schema was shaped correctly for this before any code wrote to it this
way. `idempotencyKey = "<agentRunId>:<toolCall.id>"` doubles as a
defensive uniqueness backstop for tool-call dispatch, on top of the
orchestration-level re-entry check (`run-agent-turn.test.ts` proves the
constraint itself rejects a duplicate insert, not just that the
application-level logic avoids attempting one).

## Prisma CLI / Neon connectivity
`prisma migrate dev`/`deploy` initially failed (`P1001`) against a cold Neon compute; migration was generated via `migrate diff --from-empty --to-schema` (no DB connection) and applied directly via `pg`, recorded into `_prisma_migrations` to match what `deploy` would have produced. Once compute was warm, `prisma migrate status` succeeded normally and confirmed the same state. Full writeup: decisions/0006.

## Config note
`prisma.config.ts`'s `datasource.url` is CLI-only and points at `DIRECT_DATABASE_URL`. The app's runtime `PrismaClient` (not yet written) will use `@prisma/adapter-pg` with the pooled `DATABASE_URL` instead — Prisma 7 has no `directUrl` field in `prisma.config.ts`, unlike older `schema.prisma`-embedded config.
