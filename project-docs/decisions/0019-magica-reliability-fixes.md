# 0019 — Magica reliability fixes (audit 2026-11-03)

Status: **accepted by the owner (2026-11-03)**, all six fixes (H1, H2, M1, M2, M3, L1). Implemented;
automated tests only — no provider was called.

## H1 — unknown outcome is never retried in the same run
`createMagicaTool` (`src/tools/magica-tools.ts`):
- an ambiguous start (`MagicaAmbiguousError`: network, our timeout, 5xx) or a 202 whose run id
  could not be persisted throws `ProviderOutcomeUnknownError` → the invocation is FAILED with
  **`PROVIDER_OUTCOME_UNKNOWN`**; the model is told not to call the tool again this turn.
- `assertNoUnknownOutcome` runs first on every call: if the same AgentRun already has a
  `PROVIDER_OUTCOME_UNKNOWN` invocation of the same tool, the call fails with
  **`PROVIDER_RETRY_BLOCKED`** before admission or any provider request — whatever the arguments.
  Enforced from the database, so it holds across rounds and task retries.
- Scope: the same tool in the same run. Other tools, and later runs (incl. direct tool runs a user
  submits again), are not blocked. Nothing is ever resubmitted automatically.

## H2 — results recovered later reach the chat
`persistReconciledOutcome` (`src/services/tool-reconciliation.ts`) now persists the reconciled
outcome **and** adds it to the invocation's own assistant message in one transaction
(`attachRecoveredToolResult`): a `tool_use` + `tool_result` pair, written once (message row lock;
an existing tool_result for the invocation means nothing is written). A COMPLETED result on a
still-PENDING message whose run has ended makes the message COMPLETE, so it is shown as a result,
not "Response interrupted". Failed results are added as failed tool results; the message status
is unchanged. Used by the billable sweep and the task's retry path (which re-applies the status
once the run is marked ended). Settlement is unchanged and stays exactly-once; the tool_result's
`creditsCharged` is filled from the invocation by the messages API once settled. The frontend
keeps refreshing an ended, still-pending turn for 45 minutes so the recovered result appears.
**Polling budget not raised** (also for merge_videos): durable recovery is preferred.

## M1/M2 — one output normalisation
`extractMagicaMediaUrls` (`src/tools/magica-output.ts`) is the single rule — generate/edit:
`result[]`, `images[]`; crop: `image_url`, `result[]`, `images[]`; merge: `video_url`,
`result[]`, `images[]`; https only. Persistence writes the canonical `images`; archival
(`extractGeneratedOutputs`) reads `images` then the same rule on `raw`; the chat UI reads `images`
with per-tool raw fallbacks for older rows. A COMPLETED run with no valid media fails with
**`PROVIDER_OUTPUT_INVALID`** (in-turn and on reconcile); Magica's reported usage is kept and
settled, exactly as for any failed provider run.

## M3 — archived copies first
Attachment responses carry `toolInvocationId` (additive, optional). The chat renders, per output
index, the READY generated attachment (fresh signed B2 URL) of that invocation, else the provider URL.

## L1 — orphan close-out
`sweepBillableInvocations` step 3: billable invocations RUNNING with **no** provider run id,
untouched for 15 min, whose AgentRun has ended → FAILED `PROVIDER_OUTCOME_UNKNOWN` through the
same guarded, atomic path. No usage recorded → never charged; nothing is reconciled or started.
Disjoint from step 1 (which requires a run id) and from settlement (which requires usage).

## Billing policy (owner decision, 2026-11-03)
Three outcomes are kept distinct; settlement and the ledger are unchanged for all of them:

| Outcome | Code | Charged |
|---|---|---|
| Explicit provider failure (Magica FAILED/CANCELED) | `MAGICA_RUN_FAILED` / `MAGICA_RUN_CANCELED` | Magica's reported `creditUsed`, if any |
| Invalid successful output (COMPLETED, no valid media) | `PROVIDER_OUTPUT_INVALID` | Magica's reported `creditUsed` — **accepted: keep charging actual usage** |
| Unknown provider outcome (ambiguous start, untracked run, orphan) | `PROVIDER_OUTCOME_UNKNOWN` (+ `PROVIDER_RETRY_BLOCKED`) | Nothing — no usage can be established |

Unknown outcomes never trigger automatic resubmission, in the turn, on task retry, or in any sweep.

## Open
M4 (live runs of edit/crop/merge) and L2 (merge output host allowlist) — see the audit.
No schema migration, no new dependency, no settlement or ledger change.
