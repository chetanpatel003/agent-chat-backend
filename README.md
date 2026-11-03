# Agent Chat — backend

REST API and durable agent worker for the Galaxy Agent Chat work trial. Frontend:
[`agent-chat-frontend`](https://github.com/chetanpatel003/agent-chat-frontend).

**Stack:** Next.js route handlers · TypeScript (strict) · PostgreSQL (Neon) + Prisma 7 · Clerk ·
Trigger.dev v4 (durable tasks, waitpoints, realtime) · OpenRouter `openrouter/free` (no paid
fallback) · Magica (Crop Image, GPT Image 2, Merge Videos) · Transloadit Community + Backblaze B2 ·
Zod · Vitest + MSW.

## What it does
- Versioned REST API (`/api/v1`): chats, messages, chat-style completions, direct Magica tool runs,
  run status, plan approvals, media uploads and media library, credits, webhook endpoints.
- Agent turns run on Trigger.dev: streamed OpenRouter output, bounded tool-calling loop, skills
  loaded on demand, plan mode with durable waitpoints, stop/interrupt, crash recovery.
- Magica media tools with credit admission and exactly-once settlement.
- Signed outbound webhooks (`agent.started`, `agent.completed`, `agent.failed`, `tool.completed`).

Documentation: `mintlify/` (Mintlify site; API reference generated from the Zod contracts with
`pnpm tsx scripts/generate-openapi.ts`). Engineering notes: `project-docs/`.

## Run locally
```sh
cp .env.example .env          # names only in the template; never commit values
pnpm install
pnpm prisma migrate deploy
pnpm dev                      # http://localhost:3001
pnpm trigger:dev              # worker: agent turns, archival, settlement, webhooks, sweeps
```
Node 22 is required (`nvm use 22`).

## Tests
```sh
pnpm vitest run --exclude src/services/send-turn.test.ts   # full suite without the live-dispatch test
pnpm vitest run src/services/send-turn.test.ts             # live: real dispatch + one OpenRouter Free request
pnpm tsc --noEmit && pnpm lint && pnpm build
```
Tests use a real database and mock every paid or external provider (MSW / injected fakes). The
one live test file sends a real OpenRouter Free request through the dev worker.

## Deployment
Not deployed yet: the Vercel CLI on the development machine needs the owner's login. The runbook,
with every environment variable name, is in `project-docs/DEPLOYMENT.md`.

## Known limitations
See `mintlify/limitations.mdx`. Highlights: Merge Videos accepts only uploaded videos with a
measured duration (5 min combined; 1.3× estimate, charged at actual usage — `project-docs/decisions/0018`),
not yet confirmed by a live merge; `edit_image`,
`crop_image` and `merge_videos` verified with fixtures, not live; load tested to 200 concurrent
admissions/turns with mocked providers (`project-docs/LOAD_TEST.md`), not 1,000.
