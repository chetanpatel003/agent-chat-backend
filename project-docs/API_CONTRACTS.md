# API_CONTRACTS — actual request/response shapes

**Status: real OpenRouter integration implemented** (checkpoint 2.2), on
top of checkpoint 2.1's admission/dispatch skeleton and 1.3's
chat/message/credit APIs. No tool execution or credit charging yet — explicitly
out of scope through checkpoint 1.3.

## Structure
`src/contracts/` — Zod-only, no Next.js/Prisma-client imports except the
generated enum const-objects (`@/generated/prisma/enums`), so values can
never drift from the database's actual enum definitions.

- `common.ts` — `successResponse(data)` envelope helper, `ErrorResponseSchema`.
- `pagination.ts` — `CursorPaginationRequestSchema`, `cursorPaginationResponse(item)`, opaque cursor encode/decode (`base64url(JSON{sortKey,id})`). **Checkpoint 1.3 change:** the cursor payload field was `createdAt`, renamed to `sortKey` — Chat orders by `lastMessageAt`, not `createdAt`, so the old name was wrong for a resource that doesn't exist yet when it was chosen. One codec for every (sortColumn, id) keyset-paginated list.
- `identity.ts` — `AuthenticatedUserResponseSchema`.
- `chat.ts` — `CreateChatRequestSchema`, `UpdateChatRequestSchema`, `ChatResponseSchema`, `ChatListResponseSchema`, **new:** `ListChatsQuerySchema` (cursor + limit + optional `q` — search doubles as a list filter, not a separate endpoint).
- `message.ts` — `MessageRoleSchema`/`MessageStatusSchema` (from Prisma enums), `ContentBlockSchema` (discriminated union: text, thinking, tool_use, tool_result, reasoning, citation, usage), `MessageResponseSchema`. **Checkpoint 1.3 change:** `PaginatedMessageResponseSchema` is no longer the generic `cursorPaginationResponse()` shape — its cursor field is named `olderCursor`, not `nextCursor`, so the pagination direction is unambiguous from the contract itself (message pages are always chronological-ascending regardless of which page; the one cursor a client ever needs means "older than this page's oldest item").
- `agent-run.ts` — `AgentRunStatusSchema`, `ToolInvocationStatusSchema`, `WaitpointStatusSchema`.
- `attachment.ts` — `AttachmentSourceSchema`, `AttachmentStatusSchema`, `AttachmentMetadataSchema`, `AttachmentResponseSchema`.
- `credits.ts` — `CreditLedgerTypeSchema`, `CreditBalanceResponseSchema`, `CreditLedgerEntrySchema`, `PaginatedCreditLedgerResponseSchema`. Credit amounts are BigInt in Postgres, Number at the API boundary — converted in the service layer.
- `enum-schema.ts` — shared `enumSchema()` helper deriving a Zod enum from a Prisma const-object enum.
- `agent-run.ts` — **checkpoint 2.1 addition:** `AgentRunResponseSchema` (direct mirror of the AgentRun row), `WaitingReasonSchema`.
- `message.ts` — **checkpoint 2.1 addition:** `SendMessageRequestSchema` (`{text}`, 1–8000 chars — plain text only, attachments out of scope), `SendMessageResponseSchema` (`{chatId, messageId, runId, triggerRunId}`).

## Routes implemented
| Route | Method | Auth | Contract |
|---|---|---|---|
| `/api/health` | GET | none | `{ ok: true }` (pre-existing) |
| `/api/v1/me` | GET | Clerk bearer | `AuthenticatedUserResponseSchema` |
| `/api/v1/chats` | GET | Clerk bearer | `ListChatsQuerySchema` query → `ChatListResponseSchema`. `q` present = search (title + message content) instead of plain listing; same cursor/ordering mechanics either way. |
| `/api/v1/chats` | POST | Clerk bearer | `CreateChatRequestSchema` body → `ChatResponseSchema`, 201 |
| `/api/v1/chats/[chatId]` | GET | Clerk bearer + ownership | → `ChatResponseSchema` |
| `/api/v1/chats/[chatId]` | PATCH | Clerk bearer + ownership | `UpdateChatRequestSchema` body (title and/or isPinned — one endpoint covers both "update title" and "pin/unpin") → `ChatResponseSchema` |
| `/api/v1/chats/[chatId]` | DELETE | Clerk bearer + ownership | → `{ id }`. Soft delete (`isDeleted = true`); the chat is gone from listing/retrieval but never hard-deleted. |
| `/api/v1/chats/[chatId]/messages` | GET | Clerk bearer + ownership | `CursorPaginationRequestSchema` query → `PaginatedMessageResponseSchema` |
| `/api/v1/chats/[chatId]/messages` | POST | Clerk bearer + ownership | **New.** Requires an `Idempotency-Key` header (required, not optional — see below). `SendMessageRequestSchema` body → `SendMessageResponseSchema`, 202. |
| `/api/v1/chats/[chatId]/runs/active` | GET | Clerk bearer + ownership | **New.** → `AgentRunResponseSchema \| null`. The reconciliation endpoint — "is something in flight for this chat right now." |
| `/api/v1/credits/balance` | GET | Clerk bearer | → `CreditBalanceResponseSchema`. No account provisioned yet = 0, never auto-created by a GET. |
| `/api/v1/credits/ledger` | GET | Clerk bearer | `CursorPaginationRequestSchema` query → `PaginatedCreditLedgerResponseSchema` |

Every route also implements `OPTIONS` for CORS preflight (`src/lib/cors.ts`).

## Route-handler shape
`src/lib/route-handler.ts` — `withRoute(handler)` wraps every route:
authenticate → call the handler → map the result to `{ok:true,data}` or
a safe error envelope. `parseSearchParams()`/`parseJsonBody()` validate
query strings and JSON bodies against a Zod schema before the handler
ever runs. `/api/v1/me` was refactored onto this same wrapper in this
checkpoint for consistency (re-tested, no behavior change).
`src/lib/errors.ts#toErrorResponse` now also maps a raw `ZodError` to 400
with a safe per-field message — every route's `.parse()` call needs no
individual try/catch for that.

## Send-turn: admission + durable dispatch (checkpoint 2.1)
`src/services/send-turn.ts#sendTurn` — one transaction creates the user
`Message` and the `AgentRun` together (`Message.agentRunId` is set for
the user's own message too, a deliberate reuse of that column so an
idempotent-replay lookup can find it — not just "the run that produced
this message"), updates `Chat.lastMessageAt`, then — once committed —
dispatches `run-agent-turn` via `.trigger()` with `AgentRun.idempotencyKey`
as Trigger.dev's own idempotency key (`idempotencyKeyTTL: "24h"`,
verified real against the installed SDK, not assumed — see
`project-docs/PHASE2-PLAN.md`).

**Idempotent retry:** a resend with the same `Idempotency-Key` header
hits the `AgentRun.idempotencyKey` unique constraint; the catch branch
re-reads and returns the original dispatch's result instead of erroring
or duplicating. **Concurrent-send conflict:** a different send while a
run is already active hits the partial unique index instead
(`AgentRun_one_active_per_chat`) → 409. Distinguishing these two P2002
cases was **empirically verified**, not guessed — the exact branch
condition is in `decisions/0009`.

**If `.trigger()` itself fails** (network, Trigger.dev outage) after the
transaction already committed: the AgentRun is marked `FAILED` with
`errorCode: "DISPATCH_FAILED"` and the error propagates — never a fake
202 for a run nothing will process.

## The agent turn: real OpenRouter integration (checkpoint 2.2)
`src/trigger/run-agent-turn.ts#executeAgentTurn` — the real logic,
exported separately from the Trigger.dev `task()` wrapper so tests call
it in-process with the adapter mocked, rather than needing a live dev
worker for every behavioral test.

**The algorithm, in order (extended in checkpoint 2.3 — see below):**
1. Terminal-state guard (unchanged from 2.1) — a run already
   `COMPLETED`/`FAILED`/`CANCELLED` exits immediately, never reopened.
2. **Tool-call re-entry check** (checkpoint 2.3) — look for a `ToolInvocation`
   still `RUNNING` for this run. More specific than the message-level
   check below, and checked first: a tool backed by a real external run
   (Magica, Phase 3) can have its `reconcile()` handler polled to find
   out what actually happened, instead of guessing. See "Tool-calling
   framework" below for why Phase 2 stops at proving the dispatch, not a
   full resume.
3. **Ambiguous-outcome re-entry check** — look for an existing `PENDING`
   assistant `Message` for this run. Finding one means a *previous*
   execution dispatched a provider request (or was mid-way through the
   tool-calling loop) but never recorded its outcome (crashed, got
   killed for exceeding `maxDuration`, or the process died mid-flight).
   This runs before any new work, so a retry can never issue a second
   request for an attempt whose outcome is unknown.
4. Mark `RUNNING`, build conversation context (`src/providers/conversation-context.ts`).
5. Insert the assistant `Message` at `status: PENDING`, `content: []` —
   **committed before the provider call.** This one row accumulates
   every block produced across the *whole* tool-calling loop (not one
   row per model-call round) — matching the product's one-bubble-per-
   turn rendering, and matching the ambiguity granularity above: any
   crash anywhere in the loop leaves this same row at `PENDING`.
6. **The loop** (checkpoint 2.3), bounded at `MAX_TURNS = 8` model-call
   rounds: call `src/providers/openrouter.ts#callOpenRouter` with the
   accumulated history plus the tool definitions from the registry.
   - **`OpenRouterDefiniteError`** / **`OpenRouterAmbiguousError`**:
     handled exactly as in 2.2 (below), except the definite-failure path
     now also persists whatever `content` blocks the loop had already
     produced — a failure partway through a tool-calling round doesn't
     erase the part that did happen.
   - **No `tool_calls`** (the plain-text case, and the only case before
     2.3): push `thinking`/`text` blocks, mark the message `COMPLETE` and
     the run `COMPLETED` with the real routed model and token usage,
     update `Chat.lastMessageAt`. Exits the loop.
   - **`tool_calls` present**: push any accompanying narration text
     first, then the model's own tool-calling message into the in-
     progress context (required by OpenRouter's protocol: an assistant
     `tool_calls` message must be immediately followed by one `tool`-role
     message per call). Each call is validated and executed in sequence
     (not parallel — see "Tool-calling framework"), each producing a
     `tool_use`+`tool_result` block pair; the round's progress is
     persisted to the still-`PENDING` message before looping back to call
     the model again with the results.
   - **Loop exhausted** (`MAX_TURNS` rounds, never a final answer): a
     known, definite outcome — mark the message `FAILED` (content
     preserved) and the run `FAILED` with `errorCode: "TURN_LIMIT_EXCEEDED"`.

**`src/providers/openrouter.ts`** — the adapter. Hard-asserts
`OPENROUTER_MODEL === "openrouter/free"` before sending anything (never
trusts config alone); after a response, also verifies the *returned*
`model` ends in `:free` and rejects (`NON_FREE_ROUTE`) if not — the
requested model name is never proof of the actual route. 60s per-call
timeout via `AbortController`; a timeout or network failure is the only
thing classified as `OpenRouterAmbiguousError`, everything else
(including every HTTP status OpenRouter itself returns) is definite.
Response shapes (including `content: null` with reasoning carrying the
real output) verified against two real, live calls — decisions/0010, not
guessed from the docs, which don't document either behavior. Checkpoint
2.3 added an optional `tools` request parameter and `tool_calls`
response parsing (omits `tools` from the request entirely when empty, so
every production call — the registry is empty by default — is byte-
identical to the pre-2.3 request); these shapes are taken from
OpenRouter's documented schema, not a live call — decisions/0011.

**`src/providers/conversation-context.ts`** — builds the provider
message list from persisted history: most recent 40 `COMPLETE` messages,
chronological order, only `text` blocks flattened (never `thinking` —
the model's own scratch reasoning isn't re-injected as prior dialogue).
`PENDING`/`FAILED` messages are excluded, not sent as empty turns.

**Verified against the real Trigger.dev dev worker and real OpenRouter**
(not just typechecked, not mocked): a real send through the real route
dispatched a real task, which made a real `openrouter/free` call and
completed with a real routed model recorded — run repeatedly during this
checkpoint with zero duplicate dispatches or orphaned provider calls
once a test-suite issue (described in TEST_STATUS.md) was found and
fixed.

## Tool-calling framework (checkpoint 2.3)

**`src/tools/types.ts`** — `ToolDefinition<TInput, TOutput>`: `name`,
`description`, Zod `inputSchema`/`outputSchema`, `execute()`, and an
optional `reconcile()` for a tool backed by a long-running external
provider run (Magica, Phase 3).

**`src/tools/registry.ts`** — `createToolRegistry(tools?)` builds a
`Map` keyed by name, rejecting a duplicate name rather than silently
overwriting it. `PRODUCTION_TOOL_REGISTRY` is **empty by design** (per
Decision A in PHASE2-PLAN.md) — no tool is exposed to a real
conversation until Phase 3 registers the real Magica tools into this
exact mechanism. `toOpenRouterTools(registry)` converts each tool's own
`inputSchema` into OpenRouter's `tools` request shape via Zod 4's
built-in `z.toJSONSchema()` — one source of truth, nothing hand-
duplicated between validation and the schema sent to the model. `$schema`
is stripped from the output (a meta-key about the schema document, not a
property OpenRouter expects inside `parameters`).

**`executeAgentTurn(payload, registry = PRODUCTION_TOOL_REGISTRY)`** —
the registry is dependency-injected, not module-mocked: checkpoint 2.2
found `vi.mock`/`vi.spyOn` fragile for this exact codebase (a `vi.spyOn`
on the Trigger.dev task silently failed to intercept a real call — see
TEST_STATUS.md), so tests substitute their own registry (containing the
fixture tool) through this parameter instead, and production always gets
the one-argument call (the `runAgentTurn` task wrapper calls
`executeAgentTurn(payload)` with no second argument — passing it
directly as `run: executeAgentTurn` would have let Trigger.dev's own
second `ctx` argument land in `registry` and silently break the default).

**One tool call's lifecycle (`runOneToolCall` in run-agent-turn.ts):**
1. Parse `arguments` (a JSON string). Invalid JSON is **not** thrown —
   it's carried forward as `rawInput` so it still produces a real,
   auditable `ToolInvocation` row.
2. Unknown tool name → `ToolInvocation` created directly at `FAILED`,
   `errorCode: "UNKNOWN_TOOL"`. Never reaches `execute()`.
3. Malformed JSON → `FAILED`, `errorCode: "MALFORMED_ARGUMENTS"`.
4. Input that fails the tool's own Zod `inputSchema` → `FAILED`,
   `errorCode: "INVALID_INPUT"`. Never reaches `execute()` — this and
   the two cases above are the "ToolInvocation persistence" requirement
   even for a call that never runs: every `tool_use` content block
   always has a real invocation row behind it, success or failure.
5. Otherwise: `ToolInvocation` created at `RUNNING` **before** calling
   `execute()` — the durable "an attempt was made" marker, tool-side,
   mirroring the message-level `PENDING` marker for model calls.
   `idempotencyKey = "<agentRunId>:<toolCall.id>"`, unique in the schema
   — a defensive backstop against a duplicate insert, on top of the
   orchestration-level re-entry check.
6. `execute()` throws → `FAILED`, `errorCode: "EXECUTION_FAILED"`,
   `durationMs` recorded either way.
7. `execute()` succeeds but the output fails the tool's own
   `outputSchema` → `FAILED`, `errorCode: "INVALID_OUTPUT"` (defense
   against a buggy tool, not just a buggy caller — "Zod at every trust
   boundary" applies to a tool's own result too).
8. Otherwise → `COMPLETED`, output persisted.

Every outcome above produces a `tool_use` + `tool_result` content block
pair and a `{ role: "tool", tool_call_id, content }` provider message fed
back to the model on the next round — a failed tool call doesn't crash
the turn, it gives the model something to react to.

**Tool calls within one round run sequentially, not in parallel** — the
simplest design that still keeps result/charge/message ordering
deterministic. True parallel execution would need its own serialization
for the `ToolInvocation` inserts and the shared content array; not worth
it before a real tool has latency that makes it matter.

**`reconcile()` — signature-level only, per PHASE2-PLAN.md.** On re-entry,
a `ToolInvocation` still `RUNNING` whose tool defines `reconcile()` gets
it *called* (proving the mechanism dispatches to reconcile instead of a
blind re-execution or a silent give-up) — but nothing in Phase 2 has a
real async tool to safely prove a resume-the-loop-and-continue path
against, so even a resolved `reconcile()` still ends the run
`FAILED`/`AMBIGUOUS_PROVIDER_OUTCOME` this checkpoint. The
`ToolInvocation` itself is left `RUNNING` as evidence, not flipped,
mirroring the message-level `PENDING` marker. Phase 3's real Magica
integration is where this gets a full resume-and-continue test.

**Fixture tool** (`src/test-utils/fixture-tool.ts`, not `src/tools/`,
deliberately, so it reads as test infrastructure): `get_current_time`,
deterministic, no external call, with a `simulateFailure` input field
that exists purely to force the `execute()`-throws path on demand. Never
registered into `PRODUCTION_TOOL_REGISTRY`; every test injects its own
registry via `executeAgentTurn`'s second parameter.

## Pagination and search (checkpoint 1.3)
- **Chat list:** `ORDER BY isPinned DESC, lastMessageAt DESC, id DESC`, keyset cursor on `(lastMessageAt, id)`. No index currently covers `isPinned` as a leading column — correct, not yet optimally indexed at scale; see decisions/0008.
- **Message history:** `items` always chronological ascending; `olderCursor` always means "strictly older than this page's oldest item." First page (no cursor) = the most recent N messages. Internally queried DESC then reversed — see `services/message.ts`.
- **Credit ledger:** `ORDER BY createdAt DESC, id DESC`, same keyset pattern.
- **Search** (`GET /api/v1/chats?q=...`): matches chat titles (`ILIKE`) and message content (`content::text ILIKE`, one parameterized raw query via `prisma.$queryRaw`, capped at 500 matching chat ids). **Real limitation, stated plainly, not overclaimed:** content search matches the JSONB column's raw text representation, which can match non-reader-facing JSON structure (a block's `type` discriminator, a citation URL, a tool name), not only human-written text. No full-text index exists (none was in checkpoint 1.1's scope); this is a sequential scan over the user's own chats/messages — fine at this trial's scale, would need a GIN/trigram index or a precise tsvector of just the text-bearing block fields to stay fast and precise at real scale. Full detail: `services/chat.ts`'s `searchMatchingChatIds` comment.

## Auth
`src/services/auth.ts#authenticate(request)` — every future authenticated
route calls this first. Verifies the bearer token via `@clerk/backend`'s
`verifyToken()` (with `authorizedParties` = `FRONTEND_ORIGIN`), resolves
the local `User` row (fast path: `findUnique`; first-sight: fetch Clerk
profile, `create()`, catch P2002 on conflict — see decisions/0007), and
returns `{ userId, clerkUserId, user }`. Throws `UnauthorizedError` on any
failure; route handlers map that to a 401 via `src/lib/errors.ts`.

## Ownership
`src/services/ownership.ts` — one `require*Ownership(userId, id)` function
per resource (Chat, Message, AgentRun, ToolInvocation, Attachment,
CreditLedger entry), each throwing `NotFoundError` for both "doesn't
exist" and "exists but isn't yours". Message/AgentRun/ToolInvocation
checks go through their parent relation (chat, or agentRun→chat) via
Prisma relation filters, not only a denormalized owner column.

## Frontend consumption
`agent-chat-frontend/scripts/sync-contracts.mjs` copies `src/contracts/*`
(plus the Prisma enums file, import path rewritten) into
`src/lib/api/contracts/`. **This synced folder is committed** — Vercel's
build only checks out the one repo, so the sync can't run at build time;
it's a manual dev-time step, re-run and committed after a backend contract
change. `src/lib/api/client.ts` is the single `fetch()` call site
(`apiFetch`); every other frontend API module builds on it.

## Required environment variables (checkpoint 2.2 addition)
`OPENROUTER_API_KEY` (server-only, never logged or returned in any
response) and `OPENROUTER_MODEL` — must be exactly `openrouter/free`; the
adapter refuses to make a request with any other value, with no paid
fallback. Both already present in `.env.example` with placeholder values
from the original project setup; no new variables added this checkpoint.
