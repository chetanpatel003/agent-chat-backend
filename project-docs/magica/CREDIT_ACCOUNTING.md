# Credit accounting — units, settlement and admission (checkpoint 5.1)

Supersedes the unit interpretation in `CREDIT_ESTIMATION.md` (the
"six-orders-of-magnitude discrepancy" there was a naming problem, not a
value problem — see "Correction" below). Decision record:
`project-docs/decisions/0014-credit-units-and-settlement.md`.

## The unit: one raw integer everywhere

| Source | Documentation (verbatim) | Meaning |
|---|---|---|
| `POST /v1/nodes/estimate-credits` → `microcredits` | "Cost in microcredits. Divide by 1,000,000 to get credits." · "Pricing uses the same rules as run-time billing, without starting a run or charging credits." · "For output-dependent models, final usage can differ from the estimate." | raw integer |
| Run status (`get-model-run.md`) → `creditUsed` | "Credits charged in microcredits. This may be `0` before a run settles or when a failed run did not consume credits." | raw integer (same unit) |
| `GET /v1/credits/balance` → `availableBalance` | "Raw credit balance in microcredits. Divide by 1,000,000 to convert to millions." `formatted` is a legacy two-decimal millions figure (26,170,000 → "26.17"). | raw integer; ÷10⁶ = the "M" display figure |
| `GET /v1/models/{id}/pricing` | `M` suffix undefined (examples `"2.50M"`, `"0.195M"`); "Display returned credit amounts directly; do not apply an additional platform multiplier." | crop's `credits: 5000` and tier `xM` values are raw units ×10⁶ |

So "÷1,000,000 to get credits" (estimate) and "÷1,000,000 to convert to
millions" (balance) are the **same display conversion**. The application
stores and settles the raw integer (BigInt) and never divides it; any
display divides by 1,000,000 and appends "M" (e.g. 273936 → "0.27M").

## Correction to earlier notes

`CREDIT_ESTIMATION.md` read `/pricing` "5000 credits" vs estimate
`microcredits: 5000` as a 10⁶ mismatch. Both are the same raw integer.
`MODEL_SCHEMAS.md` previously stated `0.21072M` = "210.72 credits"; the
correct reading is 210,720 raw units (0.21072M display).

## Evidence (raw units)

| Case | `/pricing` | `estimate-credits` | Real `creditUsed` | Relation |
|---|---|---|---|---|
| Crop Image | 5,000 fixed | 5,000 | — | 1.0× |
| GPT Image 2, Medium 1024×1024 | 52,680 | 68,484 | — | ×1.3 exactly |
| GPT Image 2, High 1024×1024 (live run) | 210,720 | — | 273,936 | ×1.3 exactly |
| GPT Image 2, Low, size Auto (live run, output 1313×1198) | (Auto→1024×1024: 5,880) | — | 8,385 | no tier match |
| Merge Videos | 40,000/min + 10,000/min per extra video | 50,000 (design-time) | — | ambiguous |

## Remaining discrepancy (unresolved)

GPT Image 2 `/pricing` tier values are exactly 1/1.3 of both
`estimate-credits` and real `creditUsed`. Therefore `/pricing` tiers are
**not** used as an estimate authority; `estimate-credits` is. Open
question for Magica: is the tier table a pre-markup base?

## Settlement (implemented — `src/services/credit-settlement.ts`)

- Charge = the terminal run's `creditUsed`, raw integer, 1:1. No division,
  no multiplier. OpenRouter turns are never settled (zero credits).
- `creditUsed` is persisted for COMPLETED (in the normalized output) and
  FAILED/CANCELED runs (`ToolInvocation.output = { creditUsed }`) — a failed
  run may be charged.
- One transaction: lock the user's `CreditAccount` row (`FOR UPDATE`),
  claim the invocation (`creditsCharged IS NULL` guard) writing both
  `creditsUsed` (actual provider usage) and `creditsCharged` (collected),
  debit, insert a `TOOL_CHARGE` ledger row with unique
  `idempotencyKey = tool-charge:{id}`. Duplicate/concurrent attempts change nothing.
- Zero usage: `creditsUsed = creditsCharged = 0`, no ledger row.
- No usage reported (e.g. failed before a provider run): left unsettled.
- Never negative: at most the available balance is debited.
  **Outstanding shortfall = `creditsUsed - creditsCharged`** (machine-readable;
  `outstandingShortfall(userId)` sums it). No debt ledger or collection flow.
- Database `CHECK` constraints: `CreditAccount_balance_nonnegative`
  (`balance >= 0`) and `ToolInvocation_credits_collected_within_used`
  (a settled row records usage and `0 <= creditsCharged <= creditsUsed`).
- Ledger sign: positive adds credits, negative removes; `balanceAfter` is
  the balance after the entry.

### Recovery paths
1. **Durable task** `settle-tool-credits` (`src/trigger/settle-tool-credits.ts`):
   dispatched right after the invocation's terminal write, before the inline
   attempt; idempotency key `settle-tool-credits:{id}`; 5 bounded attempts.
   Independent of the parent AgentRun (works after it is terminal), reads only
   persisted state, never calls Magica.
2. **Inline attempt** (same transaction logic) so the tool_result block can
   carry `creditsCharged`; failure is logged and left to the task.
3. **Run re-entry** (`settleRunCredits`) on the stale-invocation and
   stale-message paths — supplementary, gated by the 120 s liveness check.
4. **Scheduled recovery sweep** `recover-billable-invocations`
   (`src/trigger/recover-billable-invocations.ts`, logic in
   `src/services/billable-recovery.ts`): cron `*/10 * * * *`, one sweep at a
   time (`queue.concurrencyLimit: 1`), 2 attempts, max 600 s.
   - **Stale RUNNING** billable invocations with a `providerRunId`, where both the
     invocation and its AgentRun are untouched for **15 min**
     (`STALE_RUNNING_THRESHOLD_MS`; the in-turn polling budget is 5 min):
     the tool's existing `reconcile()` with `{ singlePoll: true }` — one
     status read, no wait, independent of the AgentRun's status; never a
     start call. Outcomes are persisted by `persistReconciledOutcome` (guarded
     `status = RUNNING`, shared with run re-entry), keeping failed/cancelled
     usage; then settlement (and archival, if COMPLETED) is dispatched.
     Still-running or failed reads leave the row RUNNING for the next sweep.
   - **Terminal unsettled** billable invocations with reported usage
     (`output.creditUsed`), unchanged for **5 min** (`SETTLEMENT_GRACE_MS`) and
     created on/after `SETTLEMENT_EPOCH` (2026-11-02 12:00 UTC — usage before
     credits existed is never charged retroactively): settlement dispatched.
   - Batches: **25** per category per sweep, oldest first.
   - Settlement dispatch uses a per-invocation, per-sweep-window key
     (`settle-tool-credits:{id}:sweep:{window}`): concurrent sweeps dedupe; a
     later window can retry a job whose attempts were exhausted; settlement
     itself stays exactly-once (claim guard + unique ledger key).

**Remaining risk.** An invocation that crashed after Magica accepted the start
but before `providerRunId` was persisted cannot be reconciled (by design — it
is never restarted); a missed charge there is possible but bounded to that
window.

## Reconciliation record

2026-11-02: invocation `01a19c6c-3043-71bb-b0c3-5b3a653178a3` (generate_image,
COMPLETED, reported 273,936) had failed inline settlement because a stale
worker build predated `creditsUsed` when the CHECK constraint was applied.
Settled through `settleToolInvocationCredits`: balance 9,726,064 → 9,452,128;
ledger entry `01a19c85-ea9e-711f-b9bf-6ef2f6469362` (TOOL_CHARGE −273,936);
exactly one charge.

## Admission (implemented — `src/services/credit-admission.ts`)

| Tool | Policy |
|---|---|
| Crop Image | fixed 5,000 (pricing and estimate agree) — `INSUFFICIENT_CREDITS` if balance < 5,000 |
| GPT Image 2 text/edit, explicit size | `estimate-credits` (prompt, size, quality/n if given; never media) — `INSUFFICIENT_CREDITS` if balance < estimate; any estimate failure → `CREDIT_ESTIMATE_UNAVAILABLE` (fail closed) |
| GPT Image 2, size Auto/omitted | refused before any call: `EXPLICIT_SIZE_REQUIRED` (the model can retry with a size) |
| Merge Videos | own READY uploaded videos with measured duration only; `required = ceil(ceil((40,000 + 10,000 × (n − 1)) × S / 60) × 1.3)`, S ≤ 300 s; refusals `MERGE_SOURCE_UNSUPPORTED` / `MERGE_DURATION_UNKNOWN` / `MERGE_DURATION_LIMIT` / `INSUFFICIENT_CREDITS` (decision 0018) |

Admission is a check, not a reservation: concurrent runs may together
exceed the balance; settlement then stops at zero and records the shortfall.

## Open product decisions

1. **Credit grant:** no grant mechanism exists (nothing creates a
   `CreditAccount` with a positive balance or writes a `GRANT`). Every user
   therefore has balance 0 and cannot run billable tools until a grant
   policy is decided.
2. **Size Auto:** allow with a worst-case reservation, or keep requiring an
   explicit size.
3. **Merge Videos:** an admission rule without a reliable estimate (e.g.
   require a minimum balance, or measure source durations first).
4. **Shortfall policy:** confirm "debit to zero and record the remainder".

## Questions for Magica

1. Are `estimate-credits.microcredits`, `creditUsed`, `availableBalance` and
   `/pricing` `pricingDetails.credits` the same integer unit?
2. Why are GPT Image 2 estimates/charges exactly 1.3× the `/pricing` tiers?
3. How is size "Auto" priced, and can it be quoted before running?
4. Merge Videos: is the 50,000 design-time estimate 2 videos × 1 minute; how
   is billable duration measured; can it be quoted from the video URLs?
5. Is `creditUsed` final once COMPLETED; are FAILED/CANCELED runs charged or
   refunded?
6. Is the charge reserved at start or debited at completion; what is the
   `403` insufficient-credits body?
