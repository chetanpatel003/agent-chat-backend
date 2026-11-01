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
| `/api/v1/chats/[chatId]/runs/active` | GET | Clerk bearer + ownership | → `AgentRunResponseSchema \| null`. The reconciliation endpoint — "is something in flight for this chat right now." |
| `/api/v1/chats/[chatId]/runs/[runId]/cancel` | POST | Clerk bearer + ownership | **New (checkpoint 2.4).** → `AgentRunResponseSchema`, 200. Idempotent — an already-terminal run is returned unchanged, no write, no Trigger.dev call. |
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

## Cancellation, atomic transitions, and realtime run events (checkpoint 2.4)

**The problem this checkpoint closes:** every AgentRun/Message write
before 2.4 was an unconditional `update()` — correct for the failure
modes 2.2/2.3 designed around (a crash, a definite provider error), but
not against a *second, independent writer* racing the worker: a
cancellation request arriving mid-call, or (more remotely) two
concurrent executions of the same run. An unconditional write can't tell
"I'm the only one touching this row" from "someone else already decided
its fate" — it just overwrites.

**`src/services/run-transitions.ts`** — the one small, focused guarded-
transition primitive this checkpoint introduces (deliberately not a
state-machine framework): `casAgentRunStatus(agentRunId, from, data)`
does `agentRun.updateMany({ where: { id, status: { in: from } }, data })`
and reports `{ applied: true }` or `{ applied: false, currentStatus }` —
the row's *real* current status, read back, not guessed. `readAgentRunStatus`
is the read-only counterpart for the mid-loop check points below.
`ACTIVE_RUN_STATUSES = [QUEUED, RUNNING, WAITING]` is the one shared
`from` list every caller uses — a terminal status never belongs in it.
`SkippedTransition` is a sentinel thrown inside a `$transaction` callback
to abort it cleanly when a guarded sub-update inside affected zero rows.

**Every AgentRun status write in `run-agent-turn.ts` and `agent-run.ts`
now goes through this primitive — never a plain `update()`.** Allowed
transitions: QUEUED/RUNNING → RUNNING (the narrow re-entry case where a
prior attempt marked RUNNING but crashed before inserting the PENDING
message), QUEUED/RUNNING/WAITING → COMPLETED/FAILED/CANCELLED. A guard
that affects zero rows means another process already decided this run's
fate; the caller backs off immediately, returning
`{ status: currentStatus, skipped: true, ambiguous: false }` rather than
writing or publishing anything further.

**Atomic terminal writes.** `finalizeSuccess()` and
`markDefiniteFailure()` (the latter also used for `TURN_LIMIT_EXCEEDED`)
each wrap their Message + Chat + AgentRun writes in one `$transaction`:
the Message update is itself guarded (`WHERE status = 'PENDING'`); if it
affects zero rows (the cancel route already finalized this message), a
`SkippedTransition` aborts the *whole* transaction — the AgentRun write
never lands either. This is what makes "a crash cannot leave the
assistant message terminal while AgentRun remains RUNNING, or vice
versa" true structurally, not just by convention.

**Three status checks inside the tool-calling loop**, all read-only
(`readAgentRunStatus`), all short-circuiting to the same
`{ status, skipped: true, ambiguous: false }` shape on anything but
RUNNING:
1. Top of each loop iteration, before calling the provider ("checked
   between loop iterations").
2. Immediately after the provider call returns — the critical window: a
   cancellation could have landed in the database while the call was in
   flight.
3. Immediately before each individual tool call within a round.

Message content is now persisted after *each* tool call, not batched
once per round (checkpoint 2.3's behavior) — so a cancellation detected
partway through a multi-tool-call round never loses an earlier call's
already-finished result. This write touches only the `content` column,
never `status`, so it's safe even racing a concurrent cancel (disjoint
columns, no guard needed).

**The real concurrency mutex is the database, not an in-process lock.**
Two genuinely concurrent `executeAgentTurn()` calls for the same run can
both pass every read-check above (neither has inserted its assistant
message yet) and both reach `prisma.message.create()` — but the partial
unique index `Message_one_assistant_per_run` (DATABASE.md) lets only one
insert succeed. The loser's `P2002` (same empirically-verified
`driverAdapterError.cause.constraint.index` shape as decisions/0009) is
caught and treated as "a duplicate concurrent execution, exit skipped,"
never touching AgentRun state. Verified with a real `Promise.all` of two
`executeAgentTurn()` calls and a delayed mocked provider response to
force genuine overlap — exactly one assistant message, exactly one
provider call.

**`src/services/agent-run.ts#cancelRun(userId, chatId, agentRunId)`** —
`POST .../runs/[runId]/cancel`. Authenticates ownership through both the
chat and the run (`requireAgentRunOwnership`), then additionally checks
`run.chatId === chatId` — the run must belong to *this* chat, not just
some chat this user owns — a 404 either way, never leaking which case
applied. An already-terminal run is returned unchanged: no write, no
Trigger.dev call (true idempotency, not just "safe to retry").
Otherwise: one transaction CASes the AgentRun to CANCELLED
(`errorCode: CANCELLED_BY_USER`) and, in the same transaction, moves a
PENDING assistant message to CANCELLED *without touching its `content`*
— whatever was already persisted survives exactly as it was. Only after
that commits does it make a best-effort `runs.cancel(triggerRunId)` call
(Trigger.dev SDK — verified below); a failure there is logged and never
fails the request, since Postgres is already authoritative by that
point and the worker's own guarded checks will catch a mid-call run
regardless of whether the Trigger.dev-side cancellation lands.

**AbortSignal investigated, found unavailable for this task shape.**
The plain `task({ run })`'s context (`TaskRunContext`, re-exported from
`@trigger.dev/core` as a Zod schema — read directly, not guessed from
docs) has no `signal` field anywhere in its schema; the SDK's abort
signals (`chat-server.d.ts`, `ai.d.ts`) only exist on the newer
chat/streaming-agent helpers, a different API surface this task doesn't
use. A separate `onCancel()` lifecycle hook exists (`hooks.d.ts`) but is
a registered callback, not a signal passable to `fetch()` — wiring it
into an ad hoc AbortController would be inventing architecture the
checkpoint's scope explicitly excludes. Consequence: cancellation cannot
interrupt an in-flight OpenRouter call; it's caught by the guarded
status checks immediately before/after instead — which is what the
active-provider-call cancellation test actually proves.

**`src/contracts/run-event.ts`** — `RunEventSchema`, a discriminated
union: `run_status`, `assistant_message` (a pointer to the message's
`messageId`, never its content — renamed from Decision B's original
`assistant_text` per this checkpoint's explicit override), `tool_started`,
`tool_completed`, `tool_failed`. Every variant is `z.strictObject()` —
an unexpected field (assistant text, tool input/output, a provider
response) is a validation *failure*, not silently stripped; this is the
actual enforcement mechanism behind "events never carry content,"
proven by a contract test that asserts rejection, not just absence.
`seq` is a monotonically increasing integer per execution.

**`src/realtime/publish-run-event.ts`** — `publishRunEvent(event)`:
validates, then calls Trigger.dev's own `metadata.append("events",
event)` (verified against the installed SDK's declarations — this *is*
Decision B's entire publishing interface, not a new event bus). Never
throws: a validation failure or a `metadata.append` failure (confirmed
empirically to throw "Method not implemented" when called outside a
live task context — exactly the case in every test that doesn't inject
its own publisher) is logged and swallowed. `createRunEventEmitter(runId,
publish)` fills in `runId`/`seq`/`at` so call sites only supply what's
event-specific, and wraps the *injected* publisher (which may be a test
double) in its own try/catch too — isolation holds regardless of which
publisher is in use.

`executeAgentTurn(payload, registry, publish)` now takes `publish` as a
third dependency-injected parameter, defaulting to the real
`publishRunEvent` — same pattern as the tool registry (checkpoint 2.3),
for the same reason: module-mocking Trigger.dev's own SDK was found
fragile in checkpoint 2.2. Events are published strictly after their
triggering database commit: RUNNING after the CAS succeeds;
`assistant_message`+`run_status` after `finalizeSuccess`/
`markDefiniteFailure`'s transaction commits; `tool_started`/
`tool_completed`/`tool_failed` immediately after each corresponding
ToolInvocation write inside `runOneToolCall`. Verified directly — a test
publisher spy reads the database *inside* its own callback and asserts
the expected state is already there for every event type.

**Deliberate gap, not an oversight:** the realtime event list names
CANCELLED among the `assistant_message` triggers, but the cancellation
route is explicitly barred from publishing task metadata directly (it
runs outside any task execution context, so `metadata.append` would
target no run at all). CANCELLED visibility is REST-only — `GET
.../runs/active` or the cancel response itself — never realtime. The
worker itself also never publishes when it merely *detects* a
cancellation mid-loop, since it caused no new transition of its own to
announce.

**A known, accepted trade-off, found by the concurrency test itself:**
two truly concurrent in-process `executeAgentTurn()` calls for the same
run can race between the "winner" (the one whose `message.create()`
succeeds) completing normally and the "loser" discovering the winner's
still-`PENDING` message via the stale-message re-entry check — which
has no way to tell "a previous attempt crashed, abandoned" apart from
"a sibling is actively, legitimately working on this right now" — and
marking the run `FAILED`/`AMBIGUOUS_PROVIDER_OUTCOME` *before* the
winner's own provider call resolves. When this happens, the winner's
own guarded `finalizeSuccess` transaction correctly finds the run no
longer active and backs off (its `AgentRun` sub-update affects zero
rows) — so the outcome is never corrupted (still exactly one message,
one provider call, one terminal state), but the specific terminal state
can be the less-ideal one, discarding a perfectly good answer. **Not
fixed in 2.4**, deliberately: a real fix needs genuine liveness
information (a heartbeat/lease, or querying Trigger.dev's own run
status) that doesn't exist anywhere in this design and wasn't in
scope — "do not build a generic state-machine framework." It's accepted
because Trigger.dev's own `idempotencyKey` plus its liveness-based
retry semantics (a retry only fires once the platform has independently
concluded the previous attempt is dead) mean this specific race
essentially cannot happen between two *separate* Trigger.dev dispatches
in production; the test exercises a more aggressive, synthetic
same-process race than production ever produces.

**Phase 3 prerequisite, not fixed in 2.4 (scope explicitly excludes
changing `MAX_TURNS` behavior):** on the *last* allowed round, a
`tool_calls` response is still executed even though its result can
never be sent back to the model — the loop ends right after via
`TURN_LIMIT_EXCEEDED`. Real external tool work (and credits) would be
spent for nothing. Before registering real Magica tools, stop
dispatching new tool calls once `turn === MAX_TURNS - 1` and go straight
to the turn-limit failure instead.

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
