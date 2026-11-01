# Magica execution API — documentation-only investigation (Phase 3)

**Status: documentation reading only. No execution call was made.**
`POST /v1/nodes/{nodeType}/run` was never called — there is no safe way
to call it without actually starting a real, billable generation job,
which this investigation is explicitly barred from doing. Everything
below comes from reading
`https://magica.com/docs/api-reference/nodes/run.md` and
`https://magica.com/docs/api-reference/nodes/get-model-run.md`, quoted
or closely paraphrased with the source line where it matters; nothing
here was inferred from an actual run, because none was performed.

## 1. `POST /v1/nodes/{nodeType}/run` — exact request body structure
`nodeType` is a **path** parameter (e.g.
`https://inference.magica.com/v1/nodes/gpt_image_2/run`). Body is a
JSON object, documented with `additionalProperties: false` at the
top level:

| Field | Type | Required | Notes |
|---|---|---|---|
| `input` | object | **yes** | Model-specific fields, taken from that model's `GET /v1/models/{modelId}/schema` response. This object itself allows additional properties (the model-specific fields aren't individually enumerated in the `run` endpoint's own schema — they come entirely from the discovery endpoint). |
| `subModelId` | string | no | See item 2 below. |
| `webhook` | object | no | `url` (string, URI, **required** if `webhook` is present), `events` (array of `run.started`/`run.completed`/`run.failed`/`run.canceled`), `headers` (object of string values), `metadata` (object). |

## 2. How `subModelId` is passed
**In the request body**, as a sibling of `input` — **not** in the path
and **not** as a query parameter. (Contrast with the schema/pricing
endpoints, where the equivalent selector is itself the `{modelId}` path
segment.)

## 3. Example successful "run started" response
`202 Accepted`:
```json
{ "runId": "cmr7abc123modelrun" }
```
`runId` (string, required) is the only field documented for the
ordinary case. When `webhook` was supplied, the response additionally
includes a `webhook` object containing `signingSecret` (string) — the
docs say this is returned **only** for webhook-enabled runs.

## 4. All documented run statuses
Two different pages give two different lists, and this discrepancy is
reported as found, not smoothed over:
- `run.md` (the start-a-run page) names only the **terminal** statuses
  it discusses in passing: `COMPLETED`, `FAILED`, `CANCELED`.
- `get-model-run.md` (the polling page) documents a `status` field
  whose table lists `QUEUED`, `RUNNING`, `COMPLETED`, `FAILED`,
  `CANCELED`, and explicitly hedges with "such as" before the terminal
  examples — meaning **this list may not be exhaustive**. `QUEUED` and
  `RUNNING` are the only non-terminal statuses named anywhere in the
  docs.

**Unknown / not established:** whether any other non-terminal status
exists (e.g. a distinct "validating" or "uploading" phase) — the docs
do not say, and this was not resolved by this investigation.

## 5. Exact polling response structure — `GET /v1/nodes/runs/{runId}`
`runId` is a path parameter, the value returned by the `run` call.
OpenAPI-documented response fields:

| Field | Type | Required (per spec) |
|---|---|---|
| `id` | string | yes |
| `nodeType` | string | yes |
| `status` | string | yes |
| `createdAt` | string (date-time) | yes |
| `subModelId` | string \| null | no |
| `input` | unknown | no |
| `output` | unknown \| null | no |
| `error` | string \| null | no |
| `userMessage` | string \| null | no |
| `creditUsed` | number | no |
| `source` | string \| null | no |

**Not documented anywhere:** `updatedAt`, `completedAt`, or any other
timestamp beyond `createdAt`. The response additionally "allows
additional properties" per the OpenAPI spec, so the real response may
carry more fields than this table — not assumed or invented here.

## 6. How errors are represented
Two distinct shapes, depending on *when* the error occurs:
- **A run that failed** (status `FAILED`): the polling response's
  `error` field is a plain **string or null** — "Failure message when
  the run failed." `userMessage` (string \| null) is described
  separately as a "Safe, user-facing explanation." **No nested error
  object/code is documented for this case** — not invented here, even
  though the start-a-run page documents a structured envelope (below)
  for a *different* kind of error.
- **A request-level error on `POST .../run` itself** (e.g. an unknown
  node type): the REST error envelope —
  ```json
  { "error": "Unknown node type: not_a_model", "message": "Unknown node type: not_a_model", "code": "NOT_FOUND", "traceId": "req_..." }
  ```
  A retired model (`410`) extends this with `code: "MODEL_RETIRED"`,
  `retiredAt`, `supportedModels`, `supportedModelCatalog`, plus
  `Deprecation`/`Sunset`/`Link` headers.

## 7. How completed output is represented
**Not documented as a general contract.** `get-model-run.md` types
`output` as `unknown | null`, described only as "Model output when the
run has completed. Shape is model-specific." The **only** concrete
example anywhere in the docs is for a different model
(`nano_banana_pro`, not one of this project's three target models):
```json
"output": { "images": ["https://..."] }
```
This is reported as **one observed example for an unrelated model**,
not as a confirmed contract for `crop_image`, `gpt_image_2`, or
`merge_videos`. Per the brief's own instruction, no model-specific
output structure is invented here for any of the three.

## 8. Whether output contains URLs, file IDs, or asset IDs
**Not established generally.** The one example above uses plain HTTPS
URL strings in an `images` array — no `fileId`/`assetId` field is
mentioned anywhere in the docs for any model's output.

## 9. Whether outputs expire
**Not documented.** No retention or expiry period for run output (URLs
or otherwise) appears on either the `run.md` or `get-model-run.md`
page, or in `introduction/concepts.md` (checked — see
`MEDIA_HANDLING.md`).

## 10. Whether a documented output download endpoint exists
**No.** `GET /v1/nodes/runs/{runId}` is the only documented mechanism
for retrieving a run's result; no separate download/export endpoint is
referenced from either page.

## Summary of what remains genuinely unknown
- The full, exhaustive set of non-terminal statuses.
- Any structured shape for a failed run's `error` beyond "a string."
- `crop_image`/`gpt_image_2`/`merge_videos`'s own output field names —
  only an unrelated model's example exists.
- Output retention/expiry.
- Whether a run can be canceled via an API call (a `CANCELED` status
  exists, but no cancel endpoint was found in the pages read for this
  investigation).
