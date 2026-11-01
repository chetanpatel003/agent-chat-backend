# API_CONTRACTS — actual request/response shapes

**Status: foundation implemented** (checkpoint 1.2). One real route; the
rest of the contracts exist and are tested but have no routes built on
them yet (explicitly out of scope for this checkpoint).

## Structure
`src/contracts/` — Zod-only, no Next.js/Prisma-client imports except the
generated enum const-objects (`@/generated/prisma/enums`), so values can
never drift from the database's actual enum definitions.

- `common.ts` — `successResponse(data)` envelope helper, `ErrorResponseSchema`.
- `pagination.ts` — `CursorPaginationRequestSchema`, `cursorPaginationResponse(item)`, opaque cursor encode/decode (`base64url(JSON{createdAt,id})`).
- `identity.ts` — `AuthenticatedUserResponseSchema`.
- `chat.ts` — `CreateChatRequestSchema`, `UpdateChatRequestSchema`, `ChatResponseSchema`, `ChatListResponseSchema`.
- `message.ts` — `MessageRoleSchema`/`MessageStatusSchema` (from Prisma enums), `ContentBlockSchema` (discriminated union: text, thinking, tool_use, tool_result, reasoning, citation, usage), `MessageResponseSchema`, `PaginatedMessageResponseSchema`.
- `agent-run.ts` — `AgentRunStatusSchema`, `ToolInvocationStatusSchema`, `WaitpointStatusSchema`.
- `attachment.ts` — `AttachmentSourceSchema`, `AttachmentStatusSchema`, `AttachmentMetadataSchema`, `AttachmentResponseSchema`.
- `credits.ts` — `CreditLedgerTypeSchema`, `CreditBalanceResponseSchema`, `CreditLedgerEntrySchema`, `PaginatedCreditLedgerResponseSchema`. Credit amounts are BigInt in Postgres, Number at the API boundary — converted in the service layer.
- `enum-schema.ts` — shared `enumSchema()` helper deriving a Zod enum from a Prisma const-object enum.

## Routes implemented
| Route | Method | Auth | Contract |
|---|---|---|---|
| `/api/health` | GET | none | `{ ok: true }` (pre-existing) |
| `/api/v1/me` | GET | Clerk bearer | `AuthenticatedUserResponseSchema` |

Every route also implements `OPTIONS` for CORS preflight (`src/lib/cors.ts`).

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
