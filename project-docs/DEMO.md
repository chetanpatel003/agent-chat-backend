# Five-minute demo script

Legend: **LIVE** = verified in a real browser/provider session · **MOCK** = verified by automated
tests with mocked providers · **STATIC** = shown from persisted data or code.

| # | Minute | Show | Status |
|---|---|---|---|
| 1 | 0:00 | **Workspace**: sidebar (new chat, search, pin), chat history, pinned composer (attach, media library, plan mode); mobile chat list (sheet). | LIVE (desktop); mobile MOCK |
| 2 | 0:40 | **Streaming + status**: send a short prompt — "Thinking… Ns" → "Writing…", text streams, "Thought for Ns". Stop and Interrupt. | LIVE (verified 2026-11-03 with approved OpenRouter Free requests). Each live send = 1 free request. |
| 3 | 1:30 | **Plan mode**: toggle plan, send; approval card; approve (same run resumes) or reject. Show a recovered run's "Response interrupted" state in the test chat. | LIVE |
| 4 | 2:10 | **Tools + skills**: `src/tools/registry.ts` (one registry, Zod schemas), `agent-skills/` (3 skills, loaded on demand), parallel non-billable tools with ordered results; `POST /chats/{id}/tool-runs` in the Mintlify API reference. | STATIC + MOCK |
| 5 | 2:50 | **Uploads + media picker**: open the library (archived generated images, signed B2 thumbnails), pick in order, remove/re-add; the sent message keeps the order after reload. | LIVE (picker, order, reload); upload flow LIVE-verified earlier (3.4.4) |
| 6 | 3:30 | **Generated images**: open the main chat with the persisted Kashmir / balcony images (rendered inline from archived outputs). Do **not** generate new ones (costs credits). | LIVE (persisted) |
| 7 | 3:50 | **Merge Videos**: tool schema, durable polling, video archival and inline `<video>` playback; show the duration-based admission estimate and refusals for generated/external sources (decision 0018); no live merge has been run. | MOCK — never run live |
| 8 | 4:20 | **Credits + reliability**: balance and ledger (balance = ledger sum), exactly-once settlement, recovery sweeps, idempotency; load results (200 concurrent, mocked providers). | STATIC (DB) + MOCK |
| 9 | 4:40 | **Architecture + deployment**: two Vercel apps + Trigger.dev worker + Neon; webhooks with signatures; `DEPLOYMENT.md`. | STATIC (not deployed) |

Prep: sign in; keep `pnpm dev` (both repos) and `pnpm trigger:dev` running; use the dedicated test
chat `01a19d01-8532-78d9-b125-e9ee02bf0b43` for live sends.
