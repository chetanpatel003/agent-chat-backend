# Magica model catalog discovery (Phase 3, read-only)

**Status: discovery only.** No application code was touched, no model
was executed, no dependency was added, nothing was committed. The key
was read from the existing `MAGICA_API_KEY` environment variable and
sent only to the documented Magica API host — never printed, logged,
or persisted anywhere in this repo or its history.

## API endpoint used
`GET https://inference.magica.com/v1/models`
(base URL from `MAGICA_BASE_URL`, falling back to the documented
`https://inference.magica.com`; path and auth format confirmed from the
official docs before the call — see "Docs consulted" below.)

Authorization: `Bearer <MAGICA_API_KEY>` (per `https://magica.com/docs/api-reference/nodes/list-models.md`, format `Bearer gx_your_api_key`).

## Discovery timestamp
`2026-11-01T14:46:40.958Z` (UTC) — request start time, recorded by the
discovery script itself, not estimated afterward.

## Result
`HTTP 200`. Response body is a top-level JSON array of **88** entries,
saved complete and unmodified (byte-for-byte, exactly as received — no
re-formatting, re-indentation, or filtering) to
[`project-docs/magica/model-catalog.json`](./model-catalog.json),
21,910 bytes.

## The three requested capabilities — all found

| Capability | Found | `nodeType` | `subModelId` | Display name (`name`) | `category` | Description |
|---|---|---|---|---|---|---|
| Crop Image | ✅ | `crop_image` | *(none — single-mode node)* | `Crop Image` | `utility` | "Crop an image to the dimensions you choose." |
| GPT Image 2 | ✅ | `gpt_image_2` | `gpt-image-2-text` (Text to Image, category `text-to-image`) and `gpt-image-2-edit` (Image to Image, category `image-to-image`) | `GPT Image 2` | `text-to-image` | "OpenAI's newest image model with any-resolution support and improved quality." |
| Merge Videos | ✅ | `merge_videos` | *(none — single-mode node)* | `Merge Videos` | `utility` | "Combine multiple videos into one." |

Exact raw catalog entries (copied verbatim from `model-catalog.json`,
not retyped):

```json
{"nodeType":"crop_image","name":"Crop Image","description":"Crop an image to the dimensions you choose.","category":"utility","icon":"Crop"}
```

```json
{"nodeType":"gpt_image_2","name":"GPT Image 2","description":"OpenAI's newest image model with any-resolution support and improved quality.","category":"text-to-image","icon":"https://image.galaxy.ai/image-logos/gpt-image-1.webp","subModels":[{"subModelId":"gpt-image-2-text","label":"Text to Image","category":"text-to-image"},{"subModelId":"gpt-image-2-edit","label":"Image to Image","category":"image-to-image"}]}
```

```json
{"nodeType":"merge_videos","name":"Merge Videos","description":"Combine multiple videos into one.","category":"utility","icon":"Layers"}
```

**No generic `modelId` field exists anywhere in this catalog** (confirmed
from the docs before relying on it, not assumed): a single-mode node
(`crop_image`, `merge_videos`) is addressed by its `nodeType` alone
wherever a model identifier is needed; a multi-mode node (`gpt_image_2`)
is addressed by `nodeType` + the specific `subModelId` for the mode in
use. This matches `project-docs/TOOL_REGISTRY.md`'s existing Magica
notes, written earlier from the documented schema — this discovery
confirms those identifiers against the live catalog rather than
superseding them.

## Ambiguities investigated and resolved — none remain

- **"Merge Videos" vs. "Merge Audio & Video":** the catalog has a
  second, distinct node, `merge_audio_video` ("Combine an audio track
  with a video"). This is a *different* capability (video+audio
  muxing, not multi-video concatenation) and was **not** mistaken for
  "Merge Videos" — `merge_videos` is the unambiguous match for the
  requested capability.
- **"GPT Image 2" vs. newer same-family variants:** the catalog also
  lists `gpt_image_2_5_flare` ("GPT Image 2.5 Flare") and
  `gpt_image_2_5_sunburst` ("GPT Image 2.5 Sunburst") — later, distinct
  models in the same naming family. Neither has a display name equal to
  "GPT Image 2"; `gpt_image_2` is the only entry whose `name` field is
  the exact string "GPT Image 2", so it is the unambiguous match. (Per
  the brief's own instruction, display-name equality was checked
  explicitly — identifiers were not assumed from a loose text match.)
- **No display-name-only identifier was assumed anywhere in this
  report** — every identifier above (`nodeType`/`subModelId`) was taken
  directly from the raw saved response, not inferred from a display
  name.

## Missing capabilities
None — all three requested capabilities were found with unambiguous,
single matches.

## Not covered by this endpoint (named for completeness, not acted on)
- **Pricing** is not included in `GET /v1/models`; the docs name a
  separate `GET /v1/models/{modelId}/pricing` endpoint. Not called —
  out of scope for this discovery-only task.
- **Input schema per node** (parameters, required fields) is not in
  this list response either, per the docs. Not called for the same
  reason.

## Docs consulted (before the call, per the brief's own instruction)
- `https://magica.com/docs/introduction/overview` — pointed to the auth
  format (`Authorization: Bearer <key>`) and the Models reference page.
- `https://magica.com/docs/api-reference/nodes/list-models.md` — gave
  the exact method/path (`GET /v1/models`, host
  `https://inference.magica.com`), the response shape
  (`nodeType`/`name`/`description`/`category`/`icon`/`subModels`), and
  documented error codes (`401`, `429`, `500`) — none of which were hit;
  the live call returned `200` on the first attempt.

## Constraints honored
No application source code modified. No dependency added. No Magica
tool created or registered. No image/video generation executed — this
request only listed metadata, never invoked `POST /v1/nodes/{nodeType}/run`
or any execution endpoint. No paid operation triggered (a model-list
call has no documented cost). Nothing committed — `project-docs/magica/`
is new and untracked; `git add`/`git commit` were not run.
