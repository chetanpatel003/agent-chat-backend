# Magica media handling — documentation-only investigation (Phase 3)

**Status: documentation reading only.** No file was uploaded, no media
was submitted, no model was run. Sources:
`https://magica.com/docs/api-reference/media-library/upload.md` and
`https://magica.com/docs/introduction/concepts.md`, plus the field-
level descriptions already captured verbatim in
`project-docs/magica/schemas/*.json` from the prior checkpoint (the
schema responses themselves are the clearest documented statement of
the input-URL contract — quoted again below for completeness).

## How our application is expected to provide image/video inputs
**Public HTTPS URLs only — stated directly in every media-typed
field's own `description`** in the schema responses for all three
target models (`crop_image.image_url`, `gpt-image-2-edit.uploadedImages`,
`merge_videos.video_urls`), word-for-word identical each time:
> "Use public HTTPS URLs only. If the harness gives a local path like
> `/mnt/user-data/uploads/...` or `file://...`, call `upload_file`
> first and use the returned permanent URL."

This is the single clearest, most authoritative statement found on
this question — more specific than anything on the general concepts
page, which doesn't address input media format at all (confirmed by
reading it; see "What the concepts page does *not* say" below).

**Translating that into this endpoint's actual name** (the schema
text says `upload_file`, which is the name of a tool/function in
Magica's own agent-integration surface, not a literal REST path): the
real documented REST endpoint for this purpose is:

### `POST https://inference.magica.com/v1/uploads`
- Auth: `Authorization: Bearer <key>`.
- Body (JSON, `Content-Type: application/json`) — **exactly one** of:
  - `url`: a public HTTPS media URL, **or** a base64 data URI.
  - `data_uri`: a base64 data URI.
  - `base64`: raw base64 bytes — requires `content_type` alongside it.
- Optional: `media_type` (`image`/`video`/`audio`/`file`), `filename`,
  `folder` (`mcp-uploads` by default, or `media-library`).
- **Transmission:** inline in the JSON body — bytes for `data_uri`/
  `base64`, or a remote fetch performed server-side when `url` is
  given. **No multipart upload and no pre-signed-URL flow are
  documented.**
- **Response (200):** `url` (the permanent Magica URL — this is what
  you then pass into a model's input field), `media_type` (detected),
  `filename` (detected, or `null`), `metadata` (object). **No separate
  file ID is returned or documented** — the `url` itself is the only
  identifier a caller gets back.

This upload endpoint was **not called** by this investigation (calling
it would itself be "submitting media," explicitly barred).

## How generated/output media is represented and retrieved
Per `EXECUTION_API.md` (same finding, cross-referenced rather than
re-investigated twice): **not documented as a per-model contract.**
`GET /v1/nodes/runs/{runId}`'s `output` field is `unknown | null`,
"Shape is model-specific," with only one example from an unrelated
model (`nano_banana_pro`): `{"images": ["https://..."]}`. The concepts
page adds only one general sentence: *"Completed runs return model
output plus status, error, and credit-usage details"* — no format, no
field names, no confirmation of URL-vs-ID representation for any of
this project's three target models.

**No separate output-download endpoint exists** in any page read for
this investigation; `GET /v1/nodes/runs/{runId}` is the only documented
way to retrieve a result.

## Expiry / retention
- **Uploaded input media** (`POST /v1/uploads`): the docs describe the
  storage as **permanent**, but state **no explicit expiry period** —
  "permanent" is asserted, not quantified (no deletion policy, no
  retention-window number given).
- **Generated output media**: **not documented at all** — no mention
  of expiry, retention, or deletion for run output, on any page read.
- **Neither of these was independently verified** (doing so would
  require an actual upload or run, both barred).

## What the concepts page does *not* say (checked directly, not assumed)
`introduction/concepts.md` covers credits, run polling, and webhooks
in general terms, but:
- Does **not** describe how image/video inputs are provided (the
  `/uploads` endpoint and the schema field descriptions are the real
  source for that, used above instead).
- Does **not** describe output media format or retrieval beyond the
  one general sentence quoted above.
- Does **not** mention expiry/retention for either inputs or outputs.
- Does state the general credits mechanism: *"Each run uses credits
  from the authenticated user or active organization. Costs depend on
  the model and submitted parameters."* and names
  `GET /v1/credits/balance`, `GET /v1/models/{modelId}/pricing`,
  `GET /v1/models/catalog`, and `POST /v1/nodes/estimate-credits` as
  the four credit-related endpoints — consistent with
  `CREDIT_ESTIMATION.md`.
- On webhooks: standalone-run webhook support is implied by `run.md`'s
  own `webhook` request field (see `EXECUTION_API.md`), but the
  concepts page's webhook guidance is generic ("Execution surfaces
  that support asynchronous callbacks sign webhook deliveries with
  HMAC-SHA256...") and doesn't explicitly confirm standalone
  `POST /v1/nodes/{nodeType}/run` jobs support it versus some other
  execution surface — reported as **unknown**, not assumed either way.

## Summary — what this means for our application's integration
1. **Input media must be a public HTTPS URL.** Any user-uploaded file
   must first go through `POST /v1/uploads` (or already be hosted
   publicly) before being passed as a model input field — our
   application's existing Transloadit/Uppy upload pipeline would need
   to either host the result at a public HTTPS URL Magica can fetch,
   or our backend would call `POST /v1/uploads` itself using that
   already-public URL to get a Magica-native URL, depending on which
   endpoint actually needs it.
2. **Output format is genuinely unknown per model** until a real run is
   executed and inspected — this is a real open risk for the eventual
   integration, not resolved by documentation alone, and flagged
   plainly rather than guessed at.
3. **No retention guarantee exists for generated output** in the
   documentation — our application should not assume a Magica-
   returned output URL stays valid indefinitely; re-hosting output to
   our own storage promptly after a run completes is the safer design,
   consistent with the open question already flagged in
   `PROJECT_STATE.md`'s "Open questions" list for attachment retention.
