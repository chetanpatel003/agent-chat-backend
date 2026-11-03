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

## Implemented (checkpoints 2.1–2.4 — agent execution engine)
- `src/trigger/run-agent-turn.ts` — the durable agent-loop task (Magica
  child tasks remain Phase 3). `src/providers/openrouter.ts` —
  the OpenRouter adapter (swappable, owns no persistence/credit logic).
  `src/tools/registry.ts` — the one authoritative tool registry
  (discovery, Zod input/output, execution). `src/services/run-transitions.ts` —
  the guarded CAS primitive every AgentRun status write goes through.
  `src/realtime/publish-run-event.ts` — the Trigger.dev-metadata
  publisher. Full detail: API_CONTRACTS.md.
- `src/providers/` — Magica/Transloadit adapters remain planned (Phase 3
  and the attachments checkpoint respectively).

## Implemented (checkpoint 2.5 — application-owned skills)
- `src/skills/` — `registry.ts` (bundle discovery/validation, the
  `PRODUCTION_SKILL_REGISTRY` startup singleton), `paths.ts` (asset path
  security — map-lookup plus realpath re-verification, never a raw
  `path.resolve()` on untrusted input), `prompt.ts` (the base-prompt
  fragment advertising skill name+description), `types.ts`.
- `src/tools/skills.ts` — `load_skill`/`read_skill_asset`, the first two
  real tools in `PRODUCTION_TOOL_REGISTRY` (Decision A amended, not
  reopened — see API_CONTRACTS.md). Both are ordinary `ToolDefinition`s;
  no new agent-loop branch was added for skills.
- `agent-skills/` — the application-owned skill bundles themselves
  (content, not code): `image-editing`, `video-editing`,
  `image-analysis`.
- Full detail, including the security model and durable-resume
  behavior: API_CONTRACTS.md.

## Implemented — core interaction experience
- **Streaming**: `providers/openrouter.ts` streams (SSE) when given `onTextDelta`; the loop
  forwards deltas to the `assistant-text` Trigger.dev stream (`realtime/text-stream.ts`) and
  flushes partial text to the pending message (≤ 1/s). Metadata events stay content-free.
- **Steps / thinking**: `step` and `thinking_completed` events; `Message.thinkingMs` (timing only).
- **Waitpoints**: `services/waitpoint.ts` — `Waitpoint` row (authoritative) + Trigger.dev
  waitpoint token (suspension). Type registry in `contracts/waitpoint.ts` (PLAN today).
  Plan mode = first round without tools, then a PLAN waitpoint.
- **Stop / Interrupt**: one in-transaction cancel helper (`cancelActiveRunInTx`) used by the
  cancel route and by send-turn's interrupt admission; also cancels open waitpoints.
- **Parallel tools**: grouped execution in `run-agent-turn.ts`; billable/provider-backed calls
  stay sequential (see API_CONTRACTS.md).
- **Recovery**: `recover-waitpoints` scheduled sweep; `recover-stale-runs` sweep and
  execution-aware re-entry for runs left active with no execution (decision 0016).

## Data model
See DATABASE.md.

## Credits (checkpoint 5.1)
Billable work is Magica tool usage only (OpenRouter costs 0). Admission runs inside each Magica tool before the provider call (`services/credit-admission.ts`); settlement runs in the orchestrator after the invocation's terminal state is persisted and on run recovery (`services/credit-settlement.ts`), never inside the provider adapter. Units and policies: `project-docs/magica/CREDIT_ACCOUNTING.md`.
