# Magica model schema discovery (Phase 3, read-only)

**Status: discovery only.** No application code was touched, no model
was executed, no media was submitted, no generation was triggered, no
dependency was added, nothing was committed. The key was read from the
existing `MAGICA_API_KEY` environment variable and sent only to the
documented Magica API host — never printed, logged, or persisted
anywhere in this repo or its history.

## Endpoint verified before calling (not assumed)
Docs consulted: `https://magica.com/docs/api-reference/nodes/model-schema.md`.

**Confirmed:** `GET https://inference.magica.com/v1/models/{modelId}/schema`
— this matches the pattern given in the brief exactly. The path
parameter is named `modelId` in the docs, and accepts either a bare
`nodeType` (for a single-mode model, or to get a multi-mode model's
*default* sub-model schema) or a specific `subModelId` (to get one
sub-model's own schema). Auth: `Authorization: Bearer <MAGICA_API_KEY>`.
No request body, no documented query parameters for this endpoint.

Pricing endpoint, consulted the same way (docs:
`.../nodes/model-pricing.md`): `GET /v1/models/{modelId}/pricing`
— also read-only, no body, no media. Called for completeness since the
brief's "Information to extract" explicitly asks for pricing behavior;
see "Pricing" per model below and the note on `POST
/v1/nodes/estimate-credits` under "Not called, by choice."

## Discovery timestamp
`2026-11-01T14:49:40Z`–`14:49:42Z` UTC for the three required schema
calls (sequential, a few hundred ms apart); pricing calls immediately
after.

## Files saved (complete, unmodified JSON responses)
Required by the brief:
- [`schemas/crop-image.json`](./schemas/crop-image.json) — `GET /v1/models/crop_image/schema`, HTTP 200, 1762 bytes.
- [`schemas/gpt-image-2.json`](./schemas/gpt-image-2.json) — `GET /v1/models/gpt_image_2/schema`, HTTP 200, 2158 bytes.
- [`schemas/merge-videos.json`](./schemas/merge-videos.json) — `GET /v1/models/merge_videos/schema`, HTTP 200, 659 bytes.

**Supplementary, not required by the brief, added for completeness and
disclosed here rather than silently included:** `gpt_image_2` is
multi-mode (two sub-models with materially different input contracts —
text-to-image has no image input; image-to-image requires one). The
nodeType-level file above only captures the *default* sub-model's view
(confirmed below to be `gpt-image-2-text`). To avoid documenting an
incomplete picture of "GPT Image 2" without saying so, both sub-model
schemas were also fetched and saved:
- [`schemas/gpt-image-2-text.json`](./schemas/gpt-image-2-text.json) — `GET /v1/models/gpt-image-2-text/schema`, HTTP 200, 2290 bytes.
- [`schemas/gpt-image-2-edit.json`](./schemas/gpt-image-2-edit.json) — `GET /v1/models/gpt-image-2-edit/schema`, HTTP 200, 2724 bytes.

All five models were available (none returned a 404 or "unavailable" —
see the one real exception found, under GPT Image 2's pricing below).

---

## 1. Crop Image

### Model identification
| Field | Value |
|---|---|
| Display name | `Crop Image` |
| Model ID / nodeType | `crop_image` |
| subModelId | none — single-mode |
| category | `utility` |

### Input contract
From `schemas/crop-image.json` verbatim — 9 fields, none required
except `image_url`:

| Field | UI `type` | `dataType` | Required | Default | Allowed / constraints |
|---|---|---|---|---|---|
| `image_url` | `image` | `string` | **true** | — | `maxImages: 1`. Description requires a public HTTPS URL (an explicit note tells a client to call an `upload_file` tool first for a local/`file://` path — this is Magica-side agent-integration guidance embedded in the field description, not something this discovery acted on). |
| `x_percent` | `slider` | `number` | false | `0` | `min 0, max 100` |
| `y_percent` | `slider` | `number` | false | `0` | `min 0, max 100` |
| `width_percent` | `slider` | `number` | false | `100` | `min 0, max 100` |
| `height_percent` | `slider` | `number` | false | `100` | `min 0, max 100` |
| `width_px` | `number` | `number` | false | — | `min 1` |
| `height_px` | `number` | `number` | false | — | `min 1` |
| `x_px` | `number` | `number` | false | — | `min 0` |
| `y_px` | `number` | `number` | false | — | `min 0` |

No nested objects. No enums. Top-level `defaults` object is empty
(`{}`) — per-field defaults are on the fields themselves (above), not
duplicated in a model-wide map for this model.

### Output contract
**Not documented by this endpoint, and not inferred.** The schema
response has no `output`/`result` key at all — this endpoint is
explicitly titled "Get model input schema" in the docs and only ever
returns input fields. Separately checked the run-result docs
(`get-model-run.md`, reading only, no call made): a completed run's
`output` field is documented generically as `unknown | null`, "Shape
is model-specific" — no example or contract specific to `crop_image`
exists anywhere in the docs. Per the brief's own instruction, this gap
is reported as a gap, not filled in with an assumption.

### Pricing
`GET /v1/models/crop_image/pricing` → HTTP 200:
```json
{
  "modelId": "crop_image",
  "costSummary": "5000 credits per crop",
  "pricingApproach": "Canonical fixed charge per successful crop; no separate megapixel multiplier.",
  "pricingDetails": { "type": "fixed", "credits": 5000, "unit": "crop operation" },
  "costConfig": null
}
```
Fixed cost, 5,000 credits/crop, independent of input values — matches
`TOOL_REGISTRY.md`'s earlier documented figure exactly. No
`sampleInput` needed or useful (pricing doesn't depend on inputs for
this model); cost estimation is available but trivial here.

---

## 2. GPT Image 2

### Model identification
| Field | Value |
|---|---|
| Display name | `GPT Image 2` (nodeType-level and `gpt-image-2-text`); `GPT Image 2 Edit` (the `gpt-image-2-edit` sub-model's own `name` field — **note:** this differs from the catalog's display name for the parent node; see "Ambiguities" below) |
| Model ID / nodeType | `gpt_image_2` |
| subModelId | `gpt-image-2-text` (Text to Image, default) and `gpt-image-2-edit` (Image to Image) |
| category | `text-to-image` (nodeType and text sub-model); `image-to-image` (edit sub-model) |

**Confirmed which sub-model is "default":** `GET /v1/models/gpt_image_2/schema`
and `GET /v1/models/gpt-image-2-text/schema` returned **byte-identical
`fields`** (only `capabilities`/`defaults` differ, both empty on the
nodeType-level call) — so the default sub-model is `gpt-image-2-text`,
confirmed by direct comparison, not assumed from naming order.

### Input contract
**`gpt-image-2-text` (Text to Image) — 6 fields, 1 required:**

| Field | UI `type` | `dataType` | Required | Default | Allowed / constraints |
|---|---|---|---|---|---|
| `prompt` | `textarea` | `string` | **true** | — | max 4000 characters |
| `size` | `composite-select` | `string` | false | `"Auto"` | Presets: `Auto, 1024x1024, 1536x1024, 1024x1536, 2048x2048, 2048x1152, 3840x2160, 2160x3840`. A custom size is passed as an **object** `{"width": N, "height": N}` (not the string `"Custom"`) — width/height each 1024–3840px, multiples of 16, long:short ratio ≤ 3:1, total pixels 655,360–8,294,400. |
| `quality` | `select` | `string` | false | `"High"` | `High, Medium, Low` |
| `background` | `select` | `string` | false | `"Auto"` | `Auto, Opaque` |
| `n` | `select` | `number` | false | `1` | `1, 2, 3, 4` |
| `output_format` | `select` | `string` | false | `"PNG"` | `PNG, JPEG, WebP` |

Top-level `defaults`: `{"size":"Auto","quality":"High","background":"Auto","n":1,"output_format":"PNG"}`.
`capabilities`: `{"promptLimit":4000,"promptLimitType":"characters"}`.

**`gpt-image-2-edit` (Image to Image) — same 6 fields plus one more,
7 total, 2 required:**

All fields above, identical constraints, **plus**:

| Field | UI `type` | `dataType` | Required | Default | Allowed / constraints |
|---|---|---|---|---|---|
| `uploadedImages` | `image` | `string[]` | **true** | `[]` | Up to 10 image uploads (`maxImages: 10`). Same public-HTTPS-URL note as `crop_image`'s `image_url`. |

This is the one structurally meaningful difference between the two
sub-models' input contracts — confirmed directly from the two separate
schema responses, not inferred from the display names.

No nested objects beyond the `size` field's documented custom-object
shape (itself described in free text within the field's own
`description`, not as a separate nested schema node — the API doesn't
expose a structured sub-schema for it).

### Output contract
**Not documented, not inferred** — same situation as Crop Image: no
`output` key in any of the three schema responses for this model;
nothing model-specific documented in `get-model-run.md` either (only a
generic `unknown | null`, with an example from an unrelated model,
`nano_banana_pro`, showing `{"images": ["https://..."]}`). Given GPT
Image 2's `n` field (1–4 images per call), an array-of-URLs output
shape is plausible by analogy but **explicitly not asserted as fact**
here, per the brief's instruction not to infer undocumented output
behavior.

### Pricing — the one real ambiguity/gap found
`GET /v1/models/gpt_image_2/pricing` (the bare nodeType) → HTTP 200,
but with an **error body**, not pricing data:
```json
{ "error": "Model \"gpt_image_2\" not found. Load the model-recommendations Skill or use search_tools to find valid model IDs." }
```
This is reported exactly as received — it is data returned by the
external API, not an instruction this discovery acted on. **Finding:**
unlike the *schema* endpoint, the *pricing* endpoint does **not**
accept a bare nodeType for a multi-mode model — it requires a specific
`subModelId`. This is a real, observed inconsistency between two
documented endpoints of the same API, not assumed or guessed.

Pricing for both sub-models (identical to each other):
```json
{
  "pricingDetails": {
    "type": "tiered",
    "pricingInputs": ["quality", "size"],
    "defaultPricingInputValues": { "quality": "High", "size": "Auto" },
    "tiers": {
      "High:1024x1024": "0.21072M", "High:1536x1024": "0.16464M", "High:1024x1536": "0.16464M",
      "High:2048x2048": "0.42816M", "High:2048x1152": "0.1695M", "High:3840x2160": "0.40026M", "High:2160x3840": "0.40026M",
      "Medium:1024x1024": "0.05268M", "Medium:1536x1024": "0.04116M", "Medium:1024x1536": "0.04116M",
      "Medium:2048x2048": "0.10704M", "Medium:2048x1152": "0.04239M", "Medium:3840x2160": "0.10008M", "Medium:2160x3840": "0.10008M",
      "Low:1024x1024": "0.00588M", "Low:1536x1024": "0.00474M", "Low:1024x1536": "0.00474M",
      "Low:2048x2048": "0.01191M", "Low:2048x1152": "0.00471M", "Low:3840x2160": "0.01113M", "Low:2160x3840": "0.01113M"
    }
  },
  "note": "Pass sampleInput to get an estimatedCost value. Credits are checked and charged automatically when you call execute_tool."
}
```
(`M` = ×1,000,000 raw integer units — the same unit as `estimate-credits` and `creditUsed`: `0.21072M` = 210,720 raw units, displayed "0.21M". Range across all tiers: **4,710** (`Low:2048x1152`) to **428,160** (`High:2048x2048`) raw units per call — note real charges are exactly 1.3× these tier values; see CREDIT_ACCOUNTING.md. *Corrected in checkpoint 5.1; this previously, wrongly, read "210.72 credits".*) Cost depends on `quality` + `size` only — not on `n` (number of images) per the documented `pricingInputs`, though this wasn't independently cross-checked against an actual charge (no run was executed). **Cost estimation is available**: pass `sampleInput` (a URL-encoded JSON object built from this schema) to this same `GET .../pricing` endpoint for an exact `estimatedCost`, or `POST /v1/nodes/estimate-credits` with `{type, data?, subModelId?}` for a batch estimate (documented, **not called** — see below).

---

## 3. Merge Videos

### Model identification
| Field | Value |
|---|---|
| Display name | `Merge Videos` |
| Model ID / nodeType | `merge_videos` |
| subModelId | none — single-mode |
| category | `utility` |

### Input contract
From `schemas/merge-videos.json` verbatim — 2 fields, 1 required:

| Field | UI `type` | `dataType` | Required | Default | Allowed / constraints |
|---|---|---|---|---|---|
| `video_urls` | `video` | `string[]` | **true** | `[]` | `maxItems: 100`. Description: "Upload 2–100 videos to concatenate (in order)" — the 2-video minimum is stated only in free text, not as a machine-checkable `minItems` field. |
| `transition` | `select` | `string` | false | `"none"` | `none, fade, dissolve` |

No nested objects. Top-level `defaults` is empty (`{}`).

### Output contract
**Not documented, not inferred** — identical situation to the other two
models; no `output` key in the schema response, no model-specific
contract in `get-model-run.md`.

### Pricing
`GET /v1/models/merge_videos/pricing` → HTTP 200:
```json
{
  "costSummary": "40000 + 10000 per additional video, per billable minute",
  "pricingDetails": {
    "type": "per_minute",
    "baseCreditsPerMinute": 40000,
    "additionalVideoCreditsPerMinute": 10000,
    "additionalVideoCount": "max(0, video_urls.length - 1)",
    "billingBasis": "measured output duration in seconds / 60",
    "rounding": "floor whole credits after prorating duration"
  },
  "pricingApproach": "The input schema has no billable duration parameter: measure or assume source durations for planning, but do not invent execution fields. Partial minutes are prorated. ... The one-minute example applies only to empty design-time forms, never final execution. Missing duration measurement fails rather than charging the example.",
  "costConfig": null
}
```
Matches `TOOL_REGISTRY.md`'s earlier documented figures (`40,000/min +
10,000/min per extra video`) exactly. **Notable, reported plainly:**
cost genuinely depends on *output duration*, a value with **no
corresponding field anywhere in this model's own input schema** —
the pricing response's own text explicitly warns against inventing an
execution-time duration field to work around this. Cost estimation
with an exact figure therefore requires either `sampleInput` with a
duration-bearing value the schema doesn't define (an open question, not
resolved by this discovery) or accepting the `costSummary`/per-minute
rate as a planning-time approximation.

---

## Comparison table

| | Crop Image | GPT Image 2 (text) | GPT Image 2 (edit) | Merge Videos |
|---|---|---|---|---|
| nodeType | `crop_image` | `gpt_image_2` | `gpt_image_2` | `merge_videos` |
| subModelId | — | `gpt-image-2-text` (default) | `gpt-image-2-edit` | — |
| category | utility | text-to-image | image-to-image | utility |
| Required inputs | `image_url` | `prompt` | `prompt`, `uploadedImages` | `video_urls` |
| Total input fields | 9 | 6 | 7 | 2 |
| Media input | 1 image (URL) | none | up to 10 images (URL) | 2–100 videos (URL) |
| Enums/selects | 0 (all sliders/numbers) | 4 (`size`, `quality`, `background`, `output_format`) + `n` | same 4 + `n` | 1 (`transition`) |
| Pricing type | `fixed` | `tiered` (quality × size) | `tiered` (quality × size, identical table) | `per_minute` (+ per extra video) |
| Pricing range (raw units) | 5,000 (flat) | 4,710–428,160 (tiers; real charge ×1.3) | 4,710–428,160 (tiers; real charge ×1.3) | 40,000/min base + 10,000/min per extra video |
| Pricing accepts bare nodeType? | yes | **no** (sub-model required — see gap above) | yes (as its own subModelId) | yes |
| Output contract documented? | no | no | no | no |

## Missing / undocumented information (reported, not filled in)
1. **Output contract is undocumented for all three models** — the
   schema endpoint returns input fields only; the run-result docs give
   a generic `unknown | null` typing with one example from an unrelated
   model. Nothing model-specific was asserted.
2. **`GET /v1/models/{modelId}/pricing` rejects a bare multi-mode
   nodeType** (`gpt_image_2` → `error: "Model \"gpt_image_2\" not
   found"...`) even though the *schema* endpoint accepts it — an
   inconsistency between two documented endpoints, found by calling
   both, not assumed.
3. **Merge Videos' per-minute pricing has no corresponding duration
   field in its own input schema** — the pricing response itself flags
   this gap in its own documentation text; not resolved here.
4. **`sampleInput`-enhanced pricing and `POST /v1/nodes/estimate-credits`
   were not called**, by choice: both are documented as safe/estimate-
   only, but the brief's "GET request" instruction and its emphasis on
   avoiding anything execution-adjacent made a conservative read
   correct here — their existence and documented request/response
   shape are reported above from the docs, not exercised live.
5. **The edit sub-model's own `name` field is `"GPT Image 2 Edit"`**,
   distinct from the catalog's parent-level display name `"GPT Image
   2"` — noted under "Model identification" so it isn't silently
   conflated.

## Constraints honored
API key never exposed, logged, or persisted. No model executed (every
call was `GET .../schema` or `GET .../pricing`; `POST
/v1/nodes/{nodeType}/run` and `POST /v1/nodes/estimate-credits` were
never called). No media submitted. No generation triggered, no credits
consumed (schema/pricing-lookup calls have no documented cost). No
application source code modified. No dependency added. Nothing
committed — `project-docs/magica/` remains untracked.
