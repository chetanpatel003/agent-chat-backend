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

## Checkpoint 2.4 — migration `20261101121924_one_assistant_message_per_run`
Applied and verified: `prisma migrate status` → "Database schema is up
to date." Exact resulting DDL, confirmed by querying `pg_indexes`
directly (not assumed from the migration file):

```sql
CREATE UNIQUE INDEX "Message_one_assistant_per_run" ON public."Message" USING btree ("agentRunId") WHERE (role = 'ASSISTANT'::"MessageRole")
```

Same situation as `AgentRun_one_active_per_chat` in the 20261101000001
migration — a partial unique index has no Prisma schema-language
attribute, so this is hand-added SQL in an otherwise-empty migration
(scaffolded via `prisma migrate dev --create-only`, then edited before
`prisma migrate deploy`), not a `schema.prisma` change.

**Why:** checkpoint 2.3's design already relied on exactly one
accumulating-content-blocks ASSISTANT message per AgentRun; this index
makes that invariant database-enforced, and — more importantly — gives
two genuinely concurrent `executeAgentTurn()` invocations for the same
run a real mutex. Both can pass every re-entry read-check (neither has
inserted anything yet), but only one message insert can succeed; the
loser's `P2002` is caught in `run-agent-turn.ts` and treated as "a
duplicate concurrent execution," exiting without touching `AgentRun`
state. Verified for real in `run-agent-turn.test.ts`'s concurrency test
(`Promise.all` of two `executeAgentTurn()` calls for the same run, a
delayed mocked provider response to force overlap): exactly one
assistant message, exactly one provider call.

**Rollback:** `DROP INDEX "Message_one_assistant_per_run";` — no data
depends on the index beyond the constraint itself; nothing else
references it by name.

**Multi-assistant-message audit (required before adding this index):**
grepped every `message.create`/`messages.create` call site outside
tests and outside Prisma's own generated client — exactly one exists
(`run-agent-turn.ts`'s `pendingMessage` insert); `send-turn.ts` only
ever creates the USER message. No intentional multiple-assistant-
message-per-run workflow exists anywhere in the codebase.

## Checkpoint 2.5 — migration `20261101135129_add_run_skill`
Applied and verified: `prisma migrate status` → "Database schema is up
to date." Unlike the 2.4 index, this one is expressible directly in
`schema.prisma` (a normal composite unique constraint, not a partial
index) — generated by the ordinary `prisma migrate dev --create-only`
flow, no hand-written SQL:

```sql
CREATE TABLE "RunSkill" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "agentRunId" UUID NOT NULL,
    "skillName" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "loadedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RunSkill_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RunSkill_agentRunId_skillName_key" ON "RunSkill"("agentRunId", "skillName");
ALTER TABLE "RunSkill" ADD CONSTRAINT "RunSkill_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
```

**Why:** durable, per-run skill-loading state (deferred since checkpoint
1.1 — see the schema's own header comment and decisions/0006). `name` +
`description` for every registered skill are safe to show the model
unconditionally; a skill's actual instructions are only loaded on
demand via the `load_skill` tool, and this table is what makes "which
skills (and at which content version) this AgentRun has already
loaded" durable across a crash/retry rather than living only in
in-process memory — the same principle `buildConversationContext`
already applies to chat history.

**Not a partial index this time, but still the real concurrency guard**
for the same failure mode checkpoint 2.4 solved with
`Message_one_assistant_per_run`: `@@unique([agentRunId, skillName])`
lets `load_skill`'s own logic treat "insert succeeded" vs. "someone
else already inserted this" as the authoritative signal, rather than a
read-then-write race. **Empirically verified, not assumed from the
decisions/0009 precedent:** that precedent documented this driver-
adapter client's unusual P2002 `meta` shape
(`driverAdapterError.cause.constraint.index`, never the naive
`{ target: string[] }` shape) specifically for a hand-added raw-SQL
*partial* index; a standalone diagnostic script against the real
database confirmed this checkpoint's own *normal*, schema-declared
composite unique constraint reports the identical shape — so
`src/tools/skills.ts#isDuplicateRunSkill` checks the same
`constraint.index` field, not `target`.

**Rollback:** `DROP TABLE "RunSkill";` — nothing else references it.

**FK ordering for test cleanup:** `RunSkill` has an `ON DELETE
RESTRICT` reference to `AgentRun`, same as `ToolInvocation`/`Waitpoint`
— `src/test-utils/db-fixtures.ts#cleanupTestUsers` now deletes it
before `AgentRun`.

## Prisma CLI / Neon connectivity
`prisma migrate dev`/`deploy` initially failed (`P1001`) against a cold Neon compute; migration was generated via `migrate diff --from-empty --to-schema` (no DB connection) and applied directly via `pg`, recorded into `_prisma_migrations` to match what `deploy` would have produced. Once compute was warm, `prisma migrate status` succeeded normally and confirmed the same state. Full writeup: decisions/0006.

## Config note
`prisma.config.ts`'s `datasource.url` is CLI-only and points at `DIRECT_DATABASE_URL`. The app's runtime `PrismaClient` (not yet written) will use `@prisma/adapter-pg` with the pooled `DATABASE_URL` instead — Prisma 7 has no `directUrl` field in `prisma.config.ts`, unlike older `schema.prisma`-embedded config.

## Credit accounting (checkpoint 5.1) — no schema change
- `CreditAccount.balance`, `CreditLedger.amount/balanceAfter`, `ToolInvocation.creditsCharged`: BigInt, Magica's raw integer unit, never scaled.
- `ToolInvocation.creditsCharged IS NULL` = not yet settled; set once inside the settlement transaction (guarded update). `0` = settled with zero usage.
- `CreditLedger.idempotencyKey` (unique) = `tool-charge:{toolInvocationId}` for settlements — the database-level duplicate guard.
- Settlement locks the user's `CreditAccount` row (`SELECT … FOR UPDATE`); concurrent settlements for one user serialize. A zero-balance account row may be created to hold the lock (not a grant).
- Ledger sign: positive adds credits (GRANT/REFUND), negative removes (TOOL_CHARGE).
- Migration `20261102200000_credit_usage_and_balance_check`: adds `ToolInvocation.creditsUsed` (actual provider usage; `creditsCharged` = amount collected; shortfall = the difference) and two hand-written CHECK constraints — `CreditAccount_balance_nonnegative` (`balance >= 0`) and `ToolInvocation_credits_collected_within_used` (`creditsCharged IS NULL OR (creditsUsed IS NOT NULL AND 0 <= creditsCharged <= creditsUsed)`). Prisma does not model CHECKs (same convention as `AgentRun_one_active_per_chat`); `migrate diff` stays empty. Rollback SQL is in the migration file.

## Interaction experience — migration `20261103100000_interaction_experience`
Additive only (safe with a running older worker):
- `AgentRun.planMode BOOLEAN NOT NULL DEFAULT false`
- `Message.thinkingMs INTEGER NULL` (timing only)
- index `Waitpoint_status_expiresAt_idx` on `Waitpoint(status, expiresAt)` for the expiry sweep.
The existing `Waitpoint` model/enums are used unchanged. Rollback statements are in the
migration file. Drift check after apply: empty.

## Media picker — migration `20261103200000_message_attachment`
New table `MessageAttachment(messageId, attachmentId, order, createdAt)`: PK (messageId,
attachmentId), unique (messageId, order), index (attachmentId), FKs cascade on delete. Backfill
inserts one row per upload already sent with a user message (no existing row is changed).
Rollback: `DROP TABLE "MessageAttachment";`. See decisions/0017.
