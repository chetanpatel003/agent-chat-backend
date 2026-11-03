# PROJECT_STATE — backend

Full chronological narrative: `~/Desktop/chat/progress.md` (workspace-level, outside this repo, **not currently git-tracked** — flagged for user decision: copy into a repo for durability, or leave local-only since it's working notes, not a deliverable).

## Day / hour
Day 1 of 3. **Phase 1 complete** — all 4 checkpoints done in both repos.

## Environment — verified working
Neon Postgres (pooled+direct), Clerk, Trigger.dev (CLI logged in, project initialized), OpenRouter (free tier, $0 used), Magica (balance 30,000,000 raw units). Not yet set: Transloadit (deferred to day 3).

## Implemented
- **Checkpoint 1.1 (database foundation): done and verified.** `prisma/schema.prisma` has the 9 required models; migration applied to Neon. See DATABASE.md.
- **Checkpoint 1.2 (auth + contracts): done and verified.** Clerk bearer-token auth (`src/services/auth.ts`), ownership checks for all 6 resource types (`src/services/ownership.ts`), full Zod contract set (`src/contracts/`), one real route (`GET /api/v1/me`), CORS. 27/27 tests passing, real HTTP smoke test against the dev server confirms live Clerk verification works. See API_CONTRACTS.md and decisions/0007 for a real concurrency bug found and fixed along the way.
- **Checkpoint 1.3 (core backend APIs): done and verified.** Chat CRUD + search (`GET/POST /api/v1/chats`, `GET/PATCH/DELETE /api/v1/chats/[chatId]`), message history (`GET /api/v1/chats/[chatId]/messages`), credits read endpoints (`GET /api/v1/credits/balance`, `GET /api/v1/credits/ledger`) — all cursor-paginated, all ownership-enforced. `src/lib/route-handler.ts` (new shared wrapper) keeps every route thin. 63/63 tests passing (36 new), real HTTP smoke test confirms every new route — including the nested dynamic segment — resolves correctly. See API_CONTRACTS.md, decisions/0008 (deferred index), and the cursor-field rename noted there.
- **Checkpoint 1.4 (frontend integration + Phase 1 verification): done.** No backend code changes — this checkpoint's work was entirely in the frontend repo (service modules, query/mutation hooks, cache strategy, 19 new tests) plus a cross-repo review. Reviewed the two deferred opportunities from 1.3 (pinned-chat index, `content::text` search) — no new evidence of a concrete correctness/performance issue, both remain correctly deferred (decisions/0008 still stands). `pnpm build` (production) verified passing, in addition to test/typecheck/lint.
- **Checkpoint 2.1 (admission + durable dispatch skeleton): done and verified.** `POST /api/v1/chats/[chatId]/messages` (idempotent send, 409 on a concurrent active run), `GET /api/v1/chats/[chatId]/runs/active`, a stub `run-agent-turn` Trigger.dev task. **Risk 1 from PHASE2-PLAN.md resolved**: `pnpm trigger:dev` run for the first time this trial — a real dispatch completed end to end (QUEUED→RUNNING→COMPLETED), and Trigger.dev's own idempotency was confirmed live, not just from docs. 74/74 tests passing (11 new). See API_CONTRACTS.md, decisions/0009 (empirically verified P2002 branch condition).
- **Checkpoint 2.2 (real OpenRouter integration + ambiguous-outcome safety): done and verified.** `src/providers/openrouter.ts` (the adapter), `src/providers/conversation-context.ts`, `src/trigger/run-agent-turn.ts`'s real `executeAgentTurn` logic replacing the 2.1 stub. The crash-recovery property decision C exists for is now **proven by a real test**, not just designed: a simulated crash (a pre-existing PENDING message found on re-entry) results in zero second provider calls, the run marked `AMBIGUOUS_PROVIDER_OUTCOME`, the message preserved at PENDING — asserted directly, not inferred. 92/92 tests passing (18 new). Two real, live OpenRouter calls made during design (decisions/0010) — the response shapes they revealed (model varies per call, `content` can be null with `reasoning` carrying the real output) directly shaped the adapter; no further live calls are in the automated suite, which uses MSW fixtures modeled on those two real responses. See API_CONTRACTS.md for the full algorithm and TEST_STATUS.md for a real test-suite issue (unintended extra real dispatches) found and fixed mid-checkpoint.
- **Checkpoint 2.3 (tool-calling framework, fixture-only): done and verified.** `src/tools/types.ts` + `registry.ts` (the authoritative, empty-by-default tool registry — Decision A), `src/test-utils/fixture-tool.ts` (test-only, never registered in production), `run-agent-turn.ts#executeAgentTurn` reworked from one OpenRouter call into a bounded (`MAX_TURNS = 8`) tool-calling loop with dependency-injected registry, `openrouter.ts` extended to send `tools`/parse `tool_calls`. Every tool call outcome — unknown name, malformed JSON, schema-invalid input, execution failure, invalid output, success — produces a real, auditable `ToolInvocation` row and a `tool_use`/`tool_result` block pair; none of them crash the turn. `reconcile()` is defined and its re-entry dispatch is proven (signature-level, per PHASE2-PLAN.md's own scope trim — Phase 2 has no real async tool to prove a full resume-and-continue path against). 114/114 tests passing (22 new), zero regressions in the 92 pre-existing ones. No live OpenRouter tool-calling call was made — would mean exposing a tool to a real conversation, which this checkpoint excludes by scope; shapes taken from documented schema instead (decisions/0011). See API_CONTRACTS.md for the full mechanism and TEST_STATUS.md for the test-by-test mapping to the approval's required coverage.
- **Checkpoint 2.4 (cancellation, guarded state transitions, realtime events): done, committed (`aa5fdc4`).** `src/services/run-transitions.ts` (the guarded CAS primitive every AgentRun status write now goes through), atomic `$transaction`-wrapped terminal writes, a new partial unique index `Message_one_assistant_per_run` (migration `20261101121924_one_assistant_message_per_run`) that doubles as the real mutex for two genuinely concurrent `executeAgentTurn()` calls, `POST .../runs/[runId]/cancel` (`src/services/agent-run.ts#cancelRun`), the realtime contract (`src/contracts/run-event.ts`) and publisher (`src/realtime/publish-run-event.ts`). AbortSignal investigated and found unavailable for this task shape (verified against the installed SDK's own type declarations). 147/148 tests passing — one known, diagnosed-but-unresolved intermittent flake ("cancelling while the provider call is active," Neon latency variance, not a logic defect). A real, narrow concurrency race found by the concurrency test itself, documented as an accepted trade-off rather than fixed. See API_CONTRACTS.md and DATABASE.md.
- **Checkpoint 2.5 (application-owned skills system): done, staged, not committed.** `agent-skills/` (3 real skill bundles), `src/skills/` (discovery/validation registry, path-security asset resolver, base-prompt builder), `src/tools/skills.ts` (`load_skill`/`read_skill_asset` — Decision A amended narrowly: `PRODUCTION_TOOL_REGISTRY` is no longer empty), a new `RunSkill` model and migration (`20261101135129_add_run_skill`) making durable, per-run skill-loading state real — the deferral named in the schema's own header comment since checkpoint 1.1 (decisions/0006) is now resolved. `executeAgentTurn` gained a fourth DI parameter (`skillRegistry`) and now prepends a synthesized skill-metadata system prompt. See API_CONTRACTS.md's "Application-owned skills system" section and DATABASE.md's checkpoint 2.5 entry; exact test counts in TEST_STATUS.md and the checkpoint 2.5 completion report.
- Not yet implemented: Magica tools (the fixture tool is the only one registered, and only in tests), uploads, waitpoints, credit charging, chat workspace UI — explicitly excluded through checkpoint 2.5.

- **Checkpoint 3.1 (execution framework hardening): done, committed in `5770f36`.** Max-round boundary fixed (a final-round tool request is recorded `CANCELLED`, never executed); a real tool-call-id-collision crash found and fixed in the OpenRouter adapter; `runOneToolCall`'s execution/persistence strictly separated; the checkpoint-2.4 concurrency race re-investigated (not assumed safe) and fixed with `isAgentRunRecentlyActive` (`src/services/run-transitions.ts`) — reuses `AgentRun.updatedAt`, already bumped every loop round, as a liveness signal. 214/215 tests passing (the one failure is the same pre-existing checkpoint-2.4 flake). See API_CONTRACTS.md.
- **Magica API discovery (3 parts, read-only, committed in `5770f36`): done.** Model catalog, full input schemas, execution API (documented only, never called), credit estimation (4 safe estimate-only calls), media handling — all under `project-docs/magica/`. Found a real, unresolved inconsistency between `/pricing`'s stated rates and `/estimate-credits`' returned values, flagged for reconciliation via a real run before any credit-ledger work.
- **Checkpoint 3.2 (Magica provider adapter + recovery plumbing): done, committed in `3a150a8`.** `src/providers/magica.ts` (HTTP adapter, corrected start-request failure classification — a 5xx or an in-flight network failure is ambiguous, never "definitely not started"), `src/services/magica-run.ts` (`persistProviderRunId`, `pollMagicaRunToCompletion`, `reconcileMagicaRun` — durable `wait.for()`-based polling, DI'd for testability since `wait.for()` throws outside a live task context, confirmed from the installed SDK's source — see decisions/0012). `ToolExecutionContext.invocationId` added (required; 21 existing test call sites updated, not 15 as first estimated). `reconcile()`'s return type narrowed to a 2-variant result; "still inconclusive" is now signaled by throwing `MagicaPollInconclusiveError`, recognized at exactly two points in `run-agent-turn.ts` so a genuinely-still-pending remote run is never mis-reported as failed. The reconciliation control-flow gap found in the Phase 3.2 architecture follow-up (a completed `reconcile()` result was being silently discarded) is fixed — persisted now, though the `AgentRun` itself still ends ambiguous (no OpenRouter-loop resumption, out of scope). **No production Magica tool was registered yet** — only a test-only fixture tool exercised this machinery. See API_CONTRACTS.md's "Magica provider adapter and execution-framework plumbing" section.
- **Checkpoint 3.3 (real Magica tools + end-to-end execution): done, staged, not committed.** `src/tools/magica-tools.ts` — `generate_image`, `edit_image`, `crop_image`, `merge_videos`, all four built on the one `createMagicaTool` factory reusing checkpoint 3.2's plumbing unchanged; all four now registered in `PRODUCTION_TOOL_REGISTRY`. Built and proved incrementally per this checkpoint's own instruction: `generate_image` was implemented first and **live-verified against the real Magica API** (one real, controlled `quality: "Low"` call via a temporary, never-committed Trigger.dev diagnostic task) before the other three were added. That live call found a real bug — the only previously-documented output shape (`{images: [...]}`, from an unrelated model) does not hold for `gpt-image-2-text`; the real shape is `{result: [url], provider, creditUsed, resultMetadata}` — fixed in `extractImageUrls()` before building the remaining tools on the same corrected code. `edit_image`/`crop_image`/`merge_videos` were not independently live-verified (not required once the shared mechanism was proven) — their output shapes remain unverified against a real response, stated plainly rather than assumed. No credit deduction or ledger settlement implemented (explicit scope exclusion); the credit-estimation pricing-unit discrepancy remains unresolved, with one new data point and one new complicating factor (`CREDIT_ESTIMATION.md`, `LIVE_VERIFICATION.md`). 46 new tests (21 in `magica-tools.test.ts` pre-existing from the `generate_image` milestone + 25 new for the other three tools), all mocked except the one live call. See API_CONTRACTS.md's "Real Magica tools and end-to-end execution" section and `project-docs/magica/LIVE_VERIFICATION.md`.

## Current phase
**Phase 3, checkpoint 3.3 complete, staged (not committed).** Plan in `project-docs/PHASE2-PLAN.md`. Awaiting approval to commit 3.3.

### Next task if resuming cold
1. Read this file + `PHASE2-PLAN.md` + `API_CONTRACTS.md` + `project-docs/magica/*` + decisions/0006–0012.
2. `git status` — checkpoint 3.3's changes are staged, not committed (2.5, 3.1, 3.2, and the Magica discovery docs are already committed as `5770f36`/`3a150a8`).
3. `pnpm test` to re-confirm the test count before building on top. Preconditions, all already documented: (a) a transient Neon-cold-start flake on the first run of a session is expected (decisions/0006) — rerun once before treating it as real; (b) `pnpm trigger:dev` must be running in a separate terminal, or `send-turn.test.ts`'s one real-dispatch test times out after 20s — also watch for the dev worker mid-rebuild (file edits trigger an automatic rebuild) coinciding with that one test, which produces the same symptom without being a regression; (c) "cancelling while the provider call is active" in `run-agent-turn.test.ts` is a known, intermittent, already-investigated flake (checkpoint 2.4) — not a regression if it alone fails.
4. Wait for the next checkpoint's instructions. Known open items: the credit-estimation pricing-unit inconsistency (`project-docs/magica/CREDIT_ESTIMATION.md`) and Magica webhook authentication (undocumented) remain unresolved; credit deduction/ledger settlement for Magica tool usage has not been implemented at all yet.

## Open questions (non-blocking for Phase 1, need answers before later phases)
1. Chat titles: auto-generated from first message, or user-named only?
2. Confirmed: no message editing, retry only (creates new AgentRun via `retryOfRunId`).
3. Attachment retention after Transloadit temp-URL expiry: re-host to S3-compatible storage, or document as known limitation?
4. Confirmed: soft delete only, no hard purge.

## Sprint log — 2026-11-03 (autonomous sprint)
Later checkpoints (3.4–5.x, interaction experience, recovery, media picker) are recorded in
`decisions/0014`–`0017`, `API_CONTRACTS.md` and the workspace `progress.md`.

- **Media picker, browser-verified (local):** library lists the 2 archived generated images with
  signed thumbnails; pick order, remove/re-add and "Already added" work; a send (worker offline, then
  Stop — no provider call) persisted `MessageAttachment` rows in the picked order; reload shows them.
  Fixed: unnamed generated items had identical labels (now include creation time). Mobile layout not
  visually verified (CDP viewport emulation rendered blank).
- **Deployment: blocked.** Vercel CLI token invalid (owner login required); runbook in `DEPLOYMENT.md`.
  Trigger.dev production deploy deliberately held until the backend and prod env vars exist.
- **Local API smoke (substitute for production smoke):** health OK; protected routes 401 without or
  with a bad token; CORS allows only `FRONTEND_ORIGIN`.
- **Public API + webhooks:** `POST /api/v1/completions`, `GET /chats/{id}/runs/{runId}`, webhook
  endpoints (`/api/v1/webhooks`), signed lifecycle events (`agent.started|completed|failed`,
  `tool.completed`) via a durable `deliver-webhook` task (6 attempts, permanent 4xx not retried,
  per-event idempotency). Migration `20261103220000_webhook_endpoint` (additive).
  Fixed a pre-existing bug: a reused Idempotency-Key could return another user's dispatch (now 409).
  Not done: direct (model-free) Magica tool execution endpoint.
- **Docs:** Mintlify site in `mintlify/` (guides + OpenAPI generated from Zod via
  `scripts/generate-openapi.ts`); READMEs rewritten. Not hosted (needs Mintlify account).
- **Load:** `LOAD_TEST.md` — correctness held to 100 concurrent; throughput pool-bound (~4.2
  admissions/s, ~1.8 turns/s per process); pool saturation now returns 503 ServiceBusy.
- **Merge videos:** backend verified by existing tests; added inline video rendering in the UI.
  **Blocked for production use:** admission is `ADMISSION_POLICY_REQUIRED` until a charging rule
  for duration-billed merges is chosen (open product decision).
- **Frontend:** chat search box (debounced, keeps previous results while loading).

## Sprint log — 2026-11-03 (final development sprint)
- **Direct Magica tool execution** (`POST /api/v1/chats/{chatId}/tool-runs`): required by the
  assessment's REST list. Reuses admission (`sendTurn`), the `run-agent-turn` task (`directTool`
  payload → one `runOneToolCall`, no model), credit admission/settlement, recovery and webhooks.
- **Merge Videos**: implementation verified (validation, order, transitions, persistence, archival,
  inline playback). Admission stays blocked; decision options recorded in `decisions/0018`.
- **Mobile**: fixed the chat-list sheet closing on any click (search was unusable on mobile).
- **Load**: pool size configurable (`DATABASE_POOL_MAX`); 200 concurrent admissions and turns pass
  at pool 40 (`LOAD_TEST.md`).
- **Runbook** rewritten as "Demo Deployment Runbook — Vercel + Trigger.dev"; demo script `DEMO.md`.
- Observed (not caused by this sprint): a real `generate_image` run in the owner's main chat at
  2026-11-02 18:48 UTC, charged once (273,936); ledger consistent (balance = ledger sum).

## Fix — media URLs in assistant prose (2026-11-03)
**Root cause.** `providers/conversation-context.ts` gives the model, as tool inputs, an
"Attached/Generated files (in order):" list of one-hour signed B2 URLs appended to each past
message. On 2026-11-03 03:02 the routed free model (`cohere/north-mini-code:free`) made **no tool
call**, claimed it had generated an image, invented a `g.tlcdn.com` URL (present in no tool output)
and copied the list format with a signed B2 URL (incl. `X-Amz-Credential` and `X-Amz-Signature`)
into its reply. Separately, 5 earlier replies pasted real Magica result URLs into prose. Nothing
filtered assistant prose, so both reached the UI as text. No charge, no tool invocation, no
attachment for that turn; the image path itself was not regressed (real generations still rendered).

**Fix (no DB rewrite, no settlement change, no new endpoint or dependency).**
- `contracts/assistant-text.ts` (synced to the frontend): `stripMediaReferences` removes the context
  file lists, Magica/B2 media URLs and any presigned (X-Amz) URL — bare, markdown or angle-bracketed —
  and drops lines left empty; unrelated links and unaffected text are returned byte-for-byte.
- Applied to assistant `text` blocks in `services/message.ts` (API responses; stored rows untouched)
  and to past assistant replies in `conversation-context.ts` (so a leaked reply is not fed back).
  User text is never altered.
- `skills/prompt.ts`: `MEDIA_REPLY_RULES` — never write media URLs or repeat the file lists; only
  claim media you generated with a successful tool call this turn.
- Webhook payloads carry no text (checked).
- Tests: `assistant-text.test.ts` (7, exact observed shape), `message.test.ts` (+1: API strips,
  user text unchanged, stored row unchanged), `conversation-context.test.ts` (+1), `prompt.test.ts` (+1).
- Live check (read-only service call on the affected chat): API assistant text has no X-Amz, no
  provider URL, no file list; the stored row still contains the original text.
- Limitation: the model can still *claim* a generation it did not perform; the prompt rule reduces
  this, and the UI never renders an image without a successful tool result.

## Run status UX + tool latency investigation (2026-11-03)
**Latency (persisted timestamps + worker log; the user's real generations, 5 completed `generate_image`):**

| Stage | Observed |
|---|---|
| Admission → Trigger.dev run started (local dev worker) | 8.5–10.2 s (consistently ~8.6 s) |
| Run start → tool call (model rounds via OpenRouter Free) | 7.5–40 s; every one of the 5 included a rejected first call with `size: "Auto"` (`EXPLICIT_SIZE_REQUIRED`), i.e. an extra model round |
| Tool call: Magica submission + provider generation + 10 s durable polling | **166.7–180.9 s (~80% of the turn)** |
| Tool done → credits settled (inline) | ~4.5 s |
| Tool done → generated asset archived (separate task) | ~3–7 s |
| Tool done → run COMPLETED | ~4–6 s |
| Total | 215.8–242 s |

Polling adds at most one 10 s interval (avg ~5 s) on top of Magica's own time; provider timestamps
aren't exposed, so Magica's exact share can't be separated further. GPT Image 2 at "High" quality,
1024×1024 is the dominant cost. Settlement/archival are a few seconds and never fail the image.
Not changed: no timeouts, polling interval, retries or credit logic. Worth considering later (not
done): stop the model choosing `size: "Auto"` (tool description/default), saving one model round.

**Change:** new run event `tool_progress` (`phase: "provider_waiting"`), emitted best-effort once a
Magica run id is persisted (`ToolExecutionContext.onProgress`; a failed publish is logged and
swallowed — it can't fail or duplicate a started billable run). Tests in `magica-tools.test.ts` (+3).

## Credit usage as operation metadata (2026-11-03)
**Root cause of the duplicate:** usage was already shown by the app under each result, but nothing told
the model not to report it, and nothing filtered its prose — so "It used 273936 credits." appeared too.
Separately, a tool_result block records `creditsCharged` only when the turn writes it; an invocation
settled afterwards (recovery/durable settlement) kept `null` in its block, so its usage never showed
(1 such real block in the DB).
- `contracts/assistant-text.ts`: `stripCreditStatements` (narrow: credit amount + past-tense
  used/consumed/charged/spent/deducted/billed/took, "<subject> cost N credits", or a "Credits used: N"
  label; parentheticals lose only the parenthesis; prices, future costs, balances and other numbers
  kept; streaming holds back an unfinished sentence heading for one) and `sanitizeAssistantText`
  (media URLs + credit statements) — used by the API mapping and model context.
- `services/message.ts`: tool_result blocks with `creditsCharged: null` get the settled amount from
  their own message's ToolInvocation (presentation only; nothing written; settlement untouched).
- `skills/prompt.ts`: "Never state how many credits a tool used".
- Tests: `credit-statements.test.ts` (20), `message.test.ts` (+1), `prompt.test.ts` (+1 assertion).


## Merge Videos admission enabled (2026-11-03)
Decision 0018 accepted (D1 1.3×, D2 no live merge, D3 300 s cap, D4 one Transloadit test, D5 uploads only).
- D4 evidence: one 3.0 s test MP4 → `durationSeconds: 3` persisted server-side (LIVE_VERIFICATION.md).
- `services/merge-admission.ts`: `resolveMergeSources` (own READY uploaded videos only, by B2 storage key
  or exact Transloadit URL; measured durations; duplicates counted; cap) and `mergeAdmissionCredits`
  (exact integer formula). `lib/b2.ts#storageKeyFromUrl` (pure parsing). `tools/magica-tools.ts`: the
  admission hook receives the execution context and may be async; merge uses the policy; image tools
  unchanged. Settlement, ledger, recovery, schema and frontend untouched; no migration.
- Tests: `merge-admission.test.ts` (19, DB-backed, Magica/OpenRouter mocked); `credit-admission.test.ts`
  merge case now expects `MERGE_SOURCE_UNSUPPORTED`; `magica-tools.test.ts` mocks the source lookup for
  its placeholder-URL execution tests.


## Magica reliability fixes (2026-11-03) — decision 0019
Audit saved as `project-docs/magica/AUDIT-2026-11-03.md`. Fixed H1 (no same-tool retry after an
unknown outcome), H2 (recovered results attached to their message; message COMPLETE), M1/M2 (one
canonical output rule; no-media completions fail visibly), M3 (archived B2 copies preferred), L1
(orphan close-out in the billable sweep). Open: M4 (live verification of edit/crop/merge), L2.
Contract: `AttachmentResponse.toolInvocationId` (optional, additive). No migration.


## Automatic chat titles (2026-11-04)
- `services/chat-title.ts`: one OpenRouter Free request (existing adapter, free route only, no
  tools) → cleaned/validated title (≤ 6 words, ≤ 50 chars, no URLs); any failure or junk → a
  deterministic title from the message (leading filler dropped). Written only while `title IS NULL`
  (`updateMany where title null`), so manual renames and earlier titles always win. Never charged.
- `trigger/generate-chat-title.ts`: task `generate-chat-title`, idempotency key `chat-title:{chatId}`,
  dispatched best-effort from `sendTurn` — scheduled with Next.js `after()` (`lib/after-response.ts`)
  so it runs **after the HTTP response is sent**; the send path itself makes no title query or
  dispatch — only when the chat is
  untitled and this is its first user message (direct tool runs skipped). Existing chats with
  history are never renamed. No migration.
- Frontend: untitled chats show "New chat"; the chat list refreshes when the reply lands and when the
  run ends, so the title appears in the sidebar.
- Rename UI not added (API + `useUpdateChatTitle` already exist). Deployed backend unchanged until
  merged and redeployed; the task registers on the next worker build.
