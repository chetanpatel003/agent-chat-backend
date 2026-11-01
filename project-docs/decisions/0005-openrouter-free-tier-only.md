# 0005 — Design around standard OpenRouter free-tier limits

**Decision:** no dedicated trial quota exists; build against the standard `openrouter/free` rate limits (~50 req/day without purchased credits).
**Why:** evaluator-confirmed, explicitly: "You can proceed with the standard free-tier limits." A 429 must be handled as a clean, user-visible terminal failure per the brief (no paid fallback) — this is required reliability behavior, not an edge case to skip.
**Consequence:** development/tests run on MSW fixtures; real OpenRouter calls reserved for verification and demo. See 0003.
