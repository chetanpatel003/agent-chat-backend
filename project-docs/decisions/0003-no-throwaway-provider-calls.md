# 0003 — No exploratory Magica/OpenRouter calls

**Decision:** don't spend Magica credits or OpenRouter free-tier requests on throwaway risk-spike tests. Use free endpoints (schema/pricing/balance) and fixtures; real calls are reserved for actual implementation verification and required acceptance evidence (one success per tool + one chain + demo).
**Why:** Galaxy account and Magica API key share one 30M-credit balance; OpenRouter free tier is ~50 req/day with no extra trial quota (evaluator-confirmed). User: "anything that can cause us credits and not worth it, leave it."
