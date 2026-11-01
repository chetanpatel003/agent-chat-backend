# generate_image — live verification (checkpoint 3.3)

**One real, controlled, `quality: "Low"` call** via a temporary
Trigger.dev task (`generateImageTool.execute()` called directly,
inside a genuine task context so `wait.for()` works — deleted after
this run; not committed). No OpenRouter call was involved — the tool
was invoked directly, deterministically, to avoid depending on model
tool-selection for a controlled, single-execution verification.

Input: `{ prompt: "a small red bicycle leaning against a plain white wall, simple flat illustration style", quality: "Low" }` (size/n/background/output_format left at Magica's own defaults).

## Results

1. **Accepted**: yes — `202`, `providerRunId: cmvy2z7aq0003jw081teae3x8`.
2. **`runId` persisted**: yes, confirmed via direct DB read-back on `ToolInvocation.providerRunId`.
3. **Polling reached a terminal state**: yes, `COMPLETED`, total elapsed **39.4s**.
4. **Actual raw output shape** — a real surprise, corrected in code as a result:
   ```json
   {
     "result": ["https://static.magica.com/decd7c541b5e46839a3e417ae0e80330.png"],
     "provider": "fal",
     "creditUsed": 8385,
     "resultMetadata": [{ "size": 1848830, "width": 1313, "height": 1198, "modelId": "gpt-image-2", "mimeType": "image/png", "mediaType": "image" }]
   }
   ```
   **Not** `{images: [...]}` — the one documented example in `EXECUTION_API.md` is for a different, unrelated model (`nano_banana_pro`) and does not hold here. `src/tools/magica-tools.ts`'s `extractImageUrls` was corrected to check `result` first (now confirmed real for this model), falling back to `images` (still unverified, kept for whatever node might actually use it).
5. **Usable output representation**: yes — `result` is an array of one plain HTTPS URL.
6. **Fetchable**: confirmed directly — `curl -I` on the URL returned `200`, `content-type: image/png`, `content-length: 1848830` (exactly matching `resultMetadata[0].size`). Publicly accessible, no auth, served from a Cloudflare-fronted CDN (`static.magica.com`).
7. **`creditUsed`**: **8385** (unit not independently re-derived here). Captured and persisted as plain descriptive data on the `ToolInvocation.output.creditUsed` field — never written to `ToolInvocation.creditsCharged` or any ledger table, per this checkpoint's explicit restriction.
8. **Persistence**: the `ToolInvocation` row was correctly created `RUNNING`, had `providerRunId` set before polling, and ended `COMPLETED` with the full output above. (This diagnostic call bypassed the normal assistant-message/OpenRouter flow by design — see above — so no assistant message was produced in this specific run; the full flow, including assistant-message persistence, is already proven by the mocked integration tests in `magica-tools.test.ts`, which exercise the real `executeAgentTurn` loop end to end.)

## Credit-unit discrepancy — one more data point, not resolved

The real resolution returned was **1313×1198** — not a round number and
not matching any documented size preset, despite `size` being left at
the default `"Auto"`. The `/pricing` endpoint's own documented mapping
(`acceptedValues.size.Auto = "1024x1024"`) does **not** hold for what
the model actually produced at runtime. This means the real `8385`
`creditUsed` value cannot be cleanly checked against the `/pricing`
tier table's `"Low:1024x1024"` entry (`"0.00588M"`) — the actual output
resolution didn't match that tier's assumed dimensions either. The
discrepancy from `CREDIT_ESTIMATION.md` is **not resolved** by this
call; it adds one genuine data point (and one new complicating factor
— `Auto`'s real resolution is unpredictable) rather than settling the
question. No credit deduction or ledger settlement was implemented, as
required.

## What this did not test

Only `generate_image`/`gpt-image-2-text` was live-verified.
`edit_image`, `crop_image`, and `merge_videos` are not yet implemented
— per this checkpoint's own explicit gate ("only after the first live
milestone has been reviewed, implement the rest"). Mocked tests for
`generate_image` cover the full tool-call lifecycle (persistence,
reconciliation, ambiguous-start handling); only this one live call
exercised the real Magica API.
