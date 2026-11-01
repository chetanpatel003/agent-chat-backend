# 0013 — generate_image's real Magica output shape, verified live, diverges from the only documented example

The Magica discovery docs (`project-docs/magica/EXECUTION_API.md`)
documented exactly one example completed-run response, for an
unrelated model (`nano_banana_pro`): `{images: [...]}`. Checkpoint 3.3
required one real, controlled live call before trusting that shape for
`gpt_image_2`/`gpt-image-2-text` — so it was verified rather than
assumed.

**One real, controlled call** (`quality: "Low"`, otherwise defaults),
made via a temporary Trigger.dev diagnostic task — created once, used
once, deleted immediately, never committed (full detail and the exact
raw response: `project-docs/magica/LIVE_VERIFICATION.md`).

**The real shape is different, not just differently named:**
```json
{
  "result": ["https://static.magica.com/....png"],
  "provider": "fal",
  "creditUsed": 8385,
  "resultMetadata": [{ "size": 1848830, "width": 1313, "height": 1198, "modelId": "gpt-image-2", "mimeType": "image/png", "mediaType": "image" }]
}
```
`images` is not present at all. The field actually holding the usable
URL array is `result`.

**Consequence, implemented before the remaining three tools were
built on top of it:** `extractImageUrls()`
(`src/tools/magica-tools.ts`) checks `result` first — now confirmed
real for this model — falling back to `images` only as an unverified
guess for whatever node might actually use that shape. The complete
raw output is always preserved regardless of which (or neither) field
matches, so no data is lost even where the guess is wrong.

**Also surfaced, not resolved:** the real output resolution
(1313×1198) matched no documented size preset despite `size` being
left at its default `"Auto"`, so the `creditUsed` value (8385) can't be
cleanly checked against the `/pricing` tier table's assumed
dimensions either. This is a new complicating factor for the
pre-existing credit-estimation discrepancy (`CREDIT_ESTIMATION.md`),
not a new issue in its own right — still unresolved, and no credit
deduction or ledger settlement was implemented regardless, per this
checkpoint's explicit scope.

No further live Magica calls are part of the automated test suite —
`magica-tools.test.ts` mocks `@/providers/magica` throughout, with one
test asserting extraction from this exact real-observed shape and
another asserting the complete raw output survives even when neither
`result` nor `images` is present. `edit_image`/`crop_image`/
`merge_videos` reuse the same corrected `extractImageUrls()` but were
not independently live-verified — their actual output shapes remain
unconfirmed against a real response.
