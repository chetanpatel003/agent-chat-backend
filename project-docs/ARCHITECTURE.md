# ARCHITECTURE — backend (implemented)

Next.js App Router, API-only (no pages/components) — the Route Handlers
layer per the assessment's "two repos + Next.js Route Handlers"
requirement, evaluator-confirmed, conditioned on this backend
independently verifying Clerk tokens and enforcing ownership (never
trusting the frontend). That condition is implemented: see
`src/services/auth.ts`.

## Implemented (checkpoint 1.2)
- `src/lib/prisma.ts` — runtime `PrismaClient` via `@prisma/adapter-pg` +
  pooled `DATABASE_URL`, bounded `pg.Pool` (max 10), dev-hot-reload-safe
  singleton. (The CLI uses the direct URL instead — `prisma.config.ts`.)
- `src/lib/clerk.ts` — Clerk Backend API client singleton.
- `src/lib/cors.ts` — shared CORS headers for the frontend's origin
  (`FRONTEND_ORIGIN`); every route exports `OPTIONS` using it.
- `src/lib/errors.ts` — `UnauthorizedError`, `NotFoundError`,
  `ValidationError` + `toErrorResponse()`, the one place a thrown error
  becomes a safe, non-leaking HTTP response.
- `src/contracts/` — see API_CONTRACTS.md.
- `src/services/auth.ts` — `authenticate(request)`, the centralized entry
  point every authenticated route calls first.
- `src/services/ownership.ts` — one `require*Ownership()` per resource
  type. See API_CONTRACTS.md.
- `src/app/api/v1/me/route.ts` — the one real route this checkpoint adds,
  proving the auth chain end to end.

## Planned shape (fill in as built)
- `src/trigger/` — durable tasks (agent loop, Magica child tasks).
- `src/providers/` — adapters: OpenRouter, Magica, Transloadit. Swappable,
  never own persistence or credit settlement.
- `src/tools/` — the one authoritative tool registry (discovery, Zod
  input/output, execution, credit estimation, rendering metadata) — see
  TOOL_REGISTRY.md.

## Data model
See DATABASE.md.
