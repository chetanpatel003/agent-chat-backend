# 0006 — Checkpoint 1.1 scope trim + Prisma/Neon connectivity finding

**Scope trim (per checkpoint 1.1's explicit required-entities list):**
- `RunSkill` not created — not in the 9 required entities for this checkpoint. Still required by the assessment's Skills System section (persist loaded skill names + content hashes, dedupe, restore on resume); deferred to the checkpoint/phase that implements skills.
- Full-text search index on `Chat.title` dropped — not in this checkpoint's design requirements; "avoid unnecessary indexes" applied. Add when chat search is actually built.

**Connectivity finding (initially misdiagnosed, corrected here):**
`prisma migrate dev`/`deploy` failed with `P1001` against both the pooled and direct Neon URLs, while Node's own `pg` driver connected to the same URLs instantly. First hypothesis (sandboxed-network block on Prisma's WASM engine) was wrong — confirmed by re-running `prisma migrate status` later, once Neon's compute had been kept warm by several `pg` queries: it succeeded immediately and reported the migration as applied and matching. The real cause was Neon's compute cold-starting from idle combined with the engine's connection-timeout tolerance being shorter than `pg`'s.

**Consequence:** migration SQL was generated via `prisma migrate diff --from-empty --to-schema` (no DB connection needed), applied directly via `pg` inside a transaction, and recorded into `_prisma_migrations` with a matching SHA-256 checksum — equivalent to what `migrate deploy` would have done. Verified after the fact: `prisma migrate status` independently confirms "Database schema is up to date."

**Watch item:** Vercel's build step will run `prisma migrate deploy` against this same Neon instance. If compute is cold at that moment, the same timeout could occur. Not fixed now (out of scope for this checkpoint) — revisit if deploy fails, e.g. by querying the DB once (via `pg`) immediately before `migrate deploy` to pre-warm it.
