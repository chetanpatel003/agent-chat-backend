# Magica credit estimation — investigation (Phase 3)

> **Correction (checkpoint 5.1):** the "six-order-of-magnitude
> inconsistency" below is superseded. All Magica endpoints share one raw
> integer unit; "÷1,000,000" only produces the "M" display figure (per the
> balance endpoint's own docs). The numbers recorded here are correct; the
> interpretation is not. See `CREDIT_ACCOUNTING.md`. The one remaining
> discrepancy is GPT Image 2's `/pricing` tiers being exactly 1/1.3 of
> both `estimate-credits` and real `creditUsed`.

**Status: estimate-only calls made, nothing executed.** Every call
below is `GET .../pricing` (read-only, no body) or `POST
/v1/nodes/estimate-credits`, which was called only after its own docs
page explicitly confirmed it does not execute a model or charge
credits (quoted verbatim below, the exact gate the brief required
before using it). `POST /v1/nodes/{nodeType}/run` was never called.
Every `estimate-credits` request body is media-free by deliberate
choice (see "What was and wasn't sent" below) — no real or placeholder
URL was ever placed in an `image_url`/`uploadedImages`/`video_urls`
field, satisfying "never submit media" without ambiguity.

## Gate: is `POST /v1/nodes/estimate-credits` confirmed estimate-only?
**Yes — quoted directly from
`https://magica.com/docs/api-reference/nodes/estimate-credits.md`:**
> "Pricing uses the same rules as run-time billing, **without starting
> a run or charging credits**."

No other sentence on the page claims otherwise, and nothing contradicts
it. On that basis, and only on that basis, the calls below were made.

## 1–4. `GET /v1/models/{modelId}/pricing` for the four targets

| Model | `costSummary` | `pricingDetails.type` | Depends on |
|---|---|---|---|
| `crop_image` | "5000 credits per crop" | `fixed` | nothing — `credits: 5000` flat |
| `gpt-image-2-text` | "0.00471–0.42816M credits (tiered)" | `tiered` | `quality` × `size` |
| `gpt-image-2-edit` | "0.00471–0.42816M credits (tiered)" (identical table to text) | `tiered` | `quality` × `size` (not `uploadedImages`) |
| `merge_videos` | "40000 + 10000 per additional video, per billable minute" | `per_minute` | output duration (seconds/60) + `max(0, video_urls.length − 1)` extra videos |

Full raw tier tables are in `MODEL_SCHEMAS.md`'s per-model pricing
sections (fetched during the prior checkpoint; re-confirmed identical
on a fresh call for this investigation).

**Note each response explicitly carries, verbatim:**
- `gpt-image-2-text`/`-edit`: *"Pass `sampleInput` to get an
  `estimatedCost` value. Credits are checked and charged automatically
  when you call `execute_tool`."*
- `merge_videos`: *"The input schema has no billable duration
  parameter: measure or assume source durations for planning, but do
  not invent execution fields. ... Missing duration measurement fails
  rather than charging the example."* — this is the API's own
  documentation telling an integrator not to fabricate a duration
  field, matching the brief's own instruction exactly.

## 5. `POST /v1/nodes/estimate-credits` — exact documented schema
Request:
```
{
  nodes: array, required, max 100 items, each:
    { type: string (required), data: object (optional), subModelId: string (optional, defaults to the default sub-model) }
}
```
Response:
```
{ estimates: [ { microcredits: number }, ... ] }   // one per node, in input order; divide by 1,000,000 for credits
```
Documented validation-error shape:
```json
{ "error": "Invalid request body", "details": [{ "path": ["nodes"], "message": "Too big: expected array to have <=100 items" }] }
```

## What was and wasn't sent
One batched request, 4 nodes, in order `crop_image`,
`gpt_image_2`/`gpt-image-2-text`, `gpt_image_2`/`gpt-image-2-edit`,
`merge_videos`. **No media field was ever populated** —
`image_url`, `uploadedImages`, and `video_urls` were all omitted from
every node's `data`, deliberately, even as a placeholder string,
because the brief's "never submit media" constraint is stricter than
"never submit a real file": omitting the field entirely removes any
ambiguity. This is possible because `data` is documented as optional
overall, and `crop_image`/`merge_videos`'s own pricing types don't
depend on their media fields anyway (confirmed above);
`gpt_image_2`'s pricing depends only on `quality`+`size`, not
`uploadedImages`, so omitting it doesn't reduce this estimate's
accuracy for that model. For `merge_videos`, per the brief's explicit
instruction, no fabricated `duration` field was added either — only
the real schema field `transition` was set.

Exact request body sent:
```json
{
  "nodes": [
    { "type": "crop_image", "data": {} },
    { "type": "gpt_image_2", "subModelId": "gpt-image-2-text", "data": { "prompt": "Cost-estimation test only; not executed.", "quality": "Medium", "size": "1024x1024" } },
    { "type": "gpt_image_2", "subModelId": "gpt-image-2-edit", "data": { "prompt": "Cost-estimation test only; not executed.", "quality": "Medium", "size": "1024x1024" } },
    { "type": "merge_videos", "data": { "transition": "fade" } }
  ]
}
```

## Results — every estimate succeeded (HTTP 200)

| # | Model | Returned `microcredits` | ÷1,000,000 (per the endpoint's own documented conversion) |
|---|---|---|---|
| 1 | Crop Image | `5000` | `0.005` credits |
| 2 | GPT Image 2 (text, Medium, 1024x1024) | `68484` | `0.068484` credits |
| 3 | GPT Image 2 (edit, Medium, 1024x1024) | `68484` | `0.068484` credits |
| 4 | Merge Videos (empty/design-time form, `transition: fade`) | `50000` | `0.05` credits |

## A real, unresolved inconsistency found — reported, not papered over

> **Superseded — see the correction at the top and `CREDIT_ACCOUNTING.md`.**
> Kept unedited below as the historical record of the original reading.
Comparing the `estimate-credits` numbers above against the `pricing`
endpoint's own stated figures for the *same* models surfaces a genuine
discrepancy that this investigation could not resolve from documentation
alone:

- **Crop Image**: `/pricing` states a flat **5,000 credits** per crop
  (`pricingDetails.credits: 5000`, no "M"/unit suffix — a plain number
  explicitly labeled credits). `/estimate-credits` returned
  `microcredits: 5000` for the identical model, which — applying the
  endpoint's own documented "divide by 1,000,000" rule — implies only
  **0.005 credits**. That is a **six-order-of-magnitude** mismatch
  against `/pricing`'s own stated flat rate for the same operation.
- **Merge Videos**: `/pricing`'s own text names a "one-minute
  design-time example" worth **40,000 credits** (base rate) for an
  empty form — almost exactly the `50000` raw number
  `/estimate-credits` returned, **if that number is read as 50,000
  credits directly, not divided by 1,000,000.**
- **GPT Image 2** (both sub-models): `/pricing`'s own tier table lists
  `"Medium:1024x1024": "0.05268M"`. If `M` means "million credits" (as
  the separate `estimatedCost` field's docs describe elsewhere —
  `"2.50M"` meaning 2.5 million credits), that tier is **52,680
  credits**. `/estimate-credits` returned `68484` microcredits for the
  same quality/size, which under the "÷1,000,000" rule is **0.068484
  credits** — again many orders of magnitude apart from the `/pricing`
  table's own number, though notably **closer in raw magnitude**
  (tens of thousands) to the `/pricing` table's tier if the tier's "M"
  suffix is instead read as "×1,000,000 **micro**credits" rather than
  "million credits" (0.05268 × 1,000,000 = 52,680 microcredits ≈ the
  same order as `68484`, though not an exact match — close enough to
  suspect a units/rounding difference, not confirmed).

**This was not resolved.** The two endpoints' numbers are internally
inconsistent with each other under the literal reading of each
endpoint's own documentation, for all three models tested, in the
same direction (the raw `microcredits` number, read at face value as
credits with no division, lines up far better with `/pricing`'s own
stated figures than the documented ÷1,000,000 conversion does).
**Before wiring real credit-ledger charges in a later checkpoint, this
needs either a direct clarification from Magica or a live, tiny,
deliberately-executed real run with a known-cheap model to observe
`creditUsed` on `GET /v1/nodes/runs/{runId}` and reconcile it against
both of these numbers — not guessed at here.**

## Answering the brief's specific questions
- **Does each estimate succeed?** Yes, all four, HTTP 200, no errors.
- **Exact returned cost?** `5000`, `68484`, `68484`, `50000`
  microcredits respectively — see table above. Not converted to a
  single confident "credits" figure, for the reason above.
- **Is cost estimation available?** Yes, both via `GET
  .../pricing?sampleInput=...` (not exercised — would need a
  URL-encoded JSON input including a `size`/`quality` already covered
  by the plain `/pricing` tier table) and via `POST
  /v1/nodes/estimate-credits` (exercised, as above).
- **Required parameters for estimating cost?** For `/estimate-credits`:
  `type` is required per node; `data`/`subModelId` are optional and
  only matter for a model whose price actually depends on them
  (`quality`/`size` for GPT Image 2; nothing for Crop Image; a
  `video_urls` array length for Merge Videos' extra-video surcharge —
  not exercised here, since testing it would have required a
  media-typed field value, which was intentionally avoided).
