# API_CONTRACTS — actual request/response shapes

**Status: message sending + durable dispatch implemented** (checkpoint
2.1 — stub task only, real OpenRouter call lands in 2.2), on top of
checkpoint 1.3's chat/message/credit APIs. No real model call, tool
execution, or credit charging yet — explicitly
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

**`src/trigger/run-agent-turn.ts`** is a **stub** this checkpoint: loads
the run, exits immediately if already terminal (idempotent re-entry —
written to match the real design in `PHASE2-PLAN.md`, not just this
stub's needs), marks `RUNNING`, writes one hardcoded assistant message,
updates `Chat.lastMessageAt`, marks `COMPLETED`. Checkpoint 2.2 replaces
the middle of this with the real OpenRouter call and the
PENDING-marker/ambiguous-outcome mechanism. **Verified running for real**
against the Trigger.dev dev worker (`pnpm trigger:dev`, started for the
first time this trial) — not just typechecked: a real dispatch produced
a real `triggerRunId`, transitioned QUEUED→RUNNING→COMPLETED on its own,
and persisted correctly; a second `.trigger()` call with the same
idempotency key returned the identical run id.

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
