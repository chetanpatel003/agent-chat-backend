# API_CONTRACTS — actual request/response shapes

**Status: core chat/message/credit read-and-write APIs implemented**
(checkpoint 1.3), on top of checkpoint 1.2's auth/contract foundation.
No message sending, agent execution, or credit charging yet — explicitly
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
