# ARCHITECTURE — backend (implemented)

**Status: not yet implemented.** This repo is Next.js App Router, API-only (no pages/components), serving as the Route Handlers layer per the assessment's "two repos + Next.js Route Handlers" requirement — evaluator-confirmed as a reasonable interpretation, conditioned on this backend independently verifying Clerk tokens and enforcing ownership (never trusting the frontend).

## Planned shape (fill in as built)
- `src/app/api/**/route.ts` — thin handlers: auth → Zod validate → call service → map response.
- `src/services/` — application services, own persistence + business rules.
- `src/contracts/` — Zod-only schemas, the single source for request/response/tool/realtime shapes. Synced to frontend by a script (not yet written).
- `src/trigger/` — durable tasks (agent loop, Magica child tasks).
- `src/providers/` — adapters: OpenRouter, Magica, Transloadit. Swappable, never own persistence or credit settlement.
- `src/tools/` — the one authoritative tool registry (discovery, Zod input/output, execution, credit estimation, rendering metadata) — see TOOL_REGISTRY.md.

## Data model
See DATABASE.md.
