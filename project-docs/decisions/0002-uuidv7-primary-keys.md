# 0002 — uuidv7() primary keys on time-series tables

**Decision:** Message, AgentRun, ToolInvocation, CreditLedger, Attachment use `uuid default uuidv7()`.
**Why:** native to Postgres 18 (confirmed live against our Neon instance: `select uuidv7()` succeeded). Time-ordered IDs make `(createdAt, id)` cursor pagination resolve ties in true insertion order without a separate sequence column — satisfies the brief's literal "(createdAt, id)" example without the tie-break edge case plain UUIDv4 would have.
**Verification:** `SELECT uuidv7()` against DATABASE_URL, 2026-11-01 — returned a valid v7 UUID.
