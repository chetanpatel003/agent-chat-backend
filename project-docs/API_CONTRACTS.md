# API_CONTRACTS — actual request/response shapes

**Status: not yet implemented.** No route handlers or Zod contracts written yet.

## Planned
- `src/contracts/` holds every Zod schema — request, response, tool I/O, realtime metadata, persisted flexible payloads.
- Frontend consumes these via a sync script (copies the contracts folder), not hand-duplicated types.
- OpenAPI (for Mintlify, bonus) generated from the same Zod schemas via `@asteasolutions/zod-to-openapi` — one source, two outputs.

Fill in real routes/schemas here as each one ships (path, method, auth, Zod input, Zod output, status codes).
