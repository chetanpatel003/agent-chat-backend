# 0014 — Credit units and exactly-once settlement

**Status:** accepted (checkpoint 5.1). Details: `project-docs/magica/CREDIT_ACCOUNTING.md`.

## Context
Magica's endpoints appeared to disagree by six orders of magnitude.
Re-reading the docs showed they share one raw integer unit
("microcredits"), and "÷1,000,000" only produces the "M" display figure.
Two independent exact matches (estimate 68,484 and live charge 273,936,
both = `/pricing` tier × 1.3) confirm estimate and charge use the same
unit and formula.

## Decision
- Application credits = Magica's raw integer unit, stored as BigInt,
  never scaled. Display divides by 1,000,000 with an "M" suffix.
- Charge = terminal `creditUsed`, 1:1, no multiplier; OpenRouter = 0.
- Settlement is one transaction: account row lock, guarded invocation
  claim (`creditsCharged IS NULL`), unique ledger `idempotencyKey`.
- Balance never goes negative; any shortfall is recorded, not debited.
- Admission only where a reliable estimate exists (crop fixed; GPT Image 2
  via `estimate-credits` with an explicit size); size Auto and Merge Videos
  are refused until a policy is approved. `/pricing` tiers are not used.

## Consequences
- Review follow-up: `ToolInvocation.creditsUsed` + two CHECK constraints (migration `20261102200000`); durable `settle-tool-credits` task.
- Finalization: scheduled `recover-billable-invocations` sweep (stale RUNNING reconcile + unsettled settlement dispatch); credit epoch 2026-11-02 12:00 UTC (no retroactive charges).
- Without a grant policy every balance is 0, so billable tools are refused.
- Open questions to Magica are listed in CREDIT_ACCOUNTING.md.
