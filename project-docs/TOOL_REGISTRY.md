# TOOL_REGISTRY — implemented tool definitions

**Status: not yet implemented** (no `src/tools/` yet). This file holds verified-real provider contracts now, pulled live from Magica, so the registry gets built against truth instead of stale docs.

## Magica tools — verified live against the API on 2026-11-01 (free schema/pricing calls, no runs executed)
Base URL: `https://inference.magica.com` (configurable via `MAGICA_BASE_URL`, never hard-coded).
Auth: `Authorization: Bearer $MAGICA_API_KEY`, server-side only.
Flow: `POST /v1/nodes/{nodeType}/run` → `202 {runId}` → poll `GET /v1/nodes/runs/{runId}` until `COMPLETED|FAILED|CANCELED`.

### crop_image — 5,000 credits/crop
`image_url`* (string) + either percent rect (`x_percent`,`y_percent`,`width_percent`,`height_percent`, 0–100) or pixel rect (`width_px`,`height_px`, optional `x_px`,`y_px` — centered if x/y omitted).

### gpt_image_2 — two sub-models, tiered pricing by quality+size (~7,700cr for Low 1024²)
- `gpt-image-2-text`: `prompt`* (≤4000 chars), `size`, `quality` (Low/Medium/High), `background`, `n` (1–4), `output_format`.
- `gpt-image-2-edit`: same + `uploadedImages`* (string[], ≤10).
Schema endpoint ignores `subModelId` param — query sub-model IDs (`gpt-image-2-text`/`gpt-image-2-edit`) directly.

### merge_videos — 40,000/min + 10,000/min per extra video
`video_urls`* (2–100, ordered), `transition` (none|fade|dissolve).

Error envelope (all endpoints): `{error, message, code, traceId}`. Documented codes: 400, 401, 403 (insufficient credits), 404, 410 (MODEL_RETIRED), 429, 500.

## Skills (minimum 3 required)
Not yet implemented. `agent-skills/<name>/SKILL.md`, YAML `name`+`description`, loaded via typed `load_skill`/`read_skill_asset` tools only. See decisions/ once skill selection is made.
