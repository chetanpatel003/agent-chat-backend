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

**The concurrency race documented here through checkpoint 2.4 is fixed
as of checkpoint 3.1** — see "Liveness-guarded re-entry" below. The
paragraph above is kept (not deleted) as the accurate historical record
of what checkpoint 2.4 actually shipped and why it was accepted at the
time; it was revisited, not assumed safe, once asked to investigate
further.

### Liveness-guarded re-entry (checkpoint 3.1)

**The gap:** both re-entry checks above (`staleToolInvocation`,
`stalePending`) had no way to tell "a previous attempt crashed,
genuinely abandoned" apart from "a sibling — or this very run, moments
into its own legitimate work — is actively in progress right now." A
truly concurrent second execution looks *identical* to a crashed one at
the instant either check runs. Checkpoint 2.4 accepted this as a narrow
trade-off, reasoning that Trigger.dev's own idempotency and liveness-
based retry semantics make two genuinely concurrent executions of the
same `AgentRun` essentially impossible in production. Checkpoint 3.1
was explicitly instructed not to assume that without evidence, and
instead to determine whether the losing execution really can
incorrectly transition the run to `FAILED` — it can (confirmed again,
deterministically, by `run-agent-turn.test.ts`'s reproduction test) —
and to implement the smallest safe correction if one exists.

**The fix:** `isAgentRunRecentlyActive(agentRunId)` in
`src/services/run-transitions.ts`. Every round of the tool-calling loop
already bumps `AgentRun.updatedAt` (the `turnCount` write, before
calling the provider), and the initial CAS to `RUNNING` does too — a
genuinely live execution's `updatedAt` is never older than roughly one
round's worst-case duration. This repurposes that *already-existing*
write as a liveness signal: no new column, no heartbeat loop, no lease
table, no generic framework — exactly the "smallest safe correction,"
not a new abstraction. Both re-entry checks now ask this question
first; if the row was written to within the last
`STALE_RUN_LIVENESS_THRESHOLD_MS` (120s — comfortable margin over one
round's worst case, far below the many minutes a legitimate multi-round
conversation could still be in progress for), the check backs off
immediately (`{ status: <current>, skipped: true, ambiguous: false }`,
nothing written) instead of concluding "stale." Only once that window
has passed does either check fall through to its original behavior
(`reconcile()`/ambiguous for a stale tool invocation; ambiguous for a
stale pending message) — crash recovery still works, it just correctly
waits out the window a live sibling could still be in before concluding
one.

**Effect on the concurrency race:** the two-concurrent-executions test
now resolves deterministically — the loser backs off (via this check,
or via losing the message-insert race outright, both safe) and the
winner completes normally, every run, not "either outcome, both safe."
See `run-agent-turn.test.ts`'s "liveness-guarded re-entry" describe
block for the direct regression test, and the existing checkpoint-2.4
concurrency test's updated assertions (it now asserts `COMPLETED`
specifically).

**What this does not change:** a tool whose real side effect completes
synchronously but crashes *after* `execute()` returns and *before* the
single `toolInvocation.update()` persisting it commits still has no
recovery path without that tool defining `reconcile()` — this was
already true before 3.1 and remains an explicit requirement for any
real external-provider tool (Magica, Phase 3), not something a time-
based liveness check can address. See "Retry and idempotency behavior"
below for the full crash-window analysis.

### Tool-call validation hardening (checkpoint 3.1)
`src/providers/openrouter.ts`'s `ToolCallSchema` now requires a
non-empty `id`, and `MessageSchema` rejects a response where two
`tool_calls` share the same `id` — both via the *existing*
`MALFORMED_RESPONSE`/`OpenRouterDefiniteError` path a non-conforming
body already took, not a new error type. A duplicate id is a provider-
protocol violation (it's the correlation key for matching a `tool`-role
reply, and `run-agent-turn.ts` derives `ToolInvocation.idempotencyKey`
from it, which is unique in the schema) — catching it at response-
validation time means it can never reach the point of attempting two
inserts under one unique key.

### Invocation lifecycle hardening (checkpoint 3.1)
`runOneToolCall` previously wrapped *both* `tool.execute()` and the
persistence of its outcome in one try/catch — a persistence failure
after a successful execution (the `toolInvocation.update()` marking
`COMPLETED`) fell into the same catch as an execution failure, which
then attempted a *second* write (`FAILED`/`EXECUTION_FAILED`) that
could itself fail and escape uncaught, or could silently overwrite an
accurate failure reason with a misleading one describing a DB error
instead. Execution and persistence are now strictly separated: the try
block decides only the tool's own outcome (`{ ok: true, output } | {
ok: false, errorCode, errorMessage }`), and there is exactly one
`toolInvocation.update()` call on every path, outside that try block.
If *that* write throws, it now propagates uncaught — the same
"rethrow and let Trigger.dev's retry policy + the re-entry/ambiguous-
outcome mechanism handle it" principle already applied to the
OpenRouter call itself, applied consistently to tool persistence too.

### Max-round boundary (checkpoint 3.1 — closes the Phase 3 prerequisite from 2.4/2.5)
On the *last* permitted round (`turn === MAX_TURNS - 1`), a `tool_calls`
response is no longer executed — its result could never be returned to
the model (there is no further round), so running it would spend real
work (real external-provider credits, once Phase 3 registers Magica
tools) for nothing. Each requested call is instead recorded `CANCELLED`
via `recordTurnLimitCancellation` — a real `ToolInvocation` row
(`errorCode: "TURN_LIMIT_EXCEEDED"`) and the usual `tool_use`/
`tool_result` content-block pair, reusing the existing
`ToolInvocationStatus.CANCELLED` value already in the schema — never
silently dropped. The run still ends `FAILED`/`TURN_LIMIT_EXCEEDED`,
exactly as when the model never stops requesting tools at all;
`MAX_TURNS` itself is unchanged (`8`), per this checkpoint's own
explicit instruction to preserve existing contracts unless essential.

### Retry and idempotency behavior (checkpoint 3.1 — documented, not newly built)
Every operation in this loop was already designed so a retry/re-entry
never blindly repeats non-idempotent work; this section makes that
explicit rather than implicit, per the three crash windows named in
the brief:
- **Before a tool's `ToolInvocation` row exists** (crash between the
  model requesting a call and `prisma.toolInvocation.create({status:
  "RUNNING"})` committing): nothing to find for that specific call on
  re-entry, but the enclosing assistant `Message` is still `PENDING` —
  caught by the liveness-guarded `stalePending` check once genuinely
  stale. The tool itself was never executed; no duplicate-execution
  risk.
- **During execution** (the row is `RUNNING`; `execute()` is in flight,
  or has returned but the single persisting write hasn't happened
  yet): re-entry's liveness-guarded `staleToolInvocation` check either
  calls `reconcile()` (if the tool defines one) or marks the run
  ambiguous once genuinely stale — `execute()` is never called a second
  time for a `RUNNING` invocation, by construction (there is no code
  path that does). This is the one case `reconcile()` exists for: a
  tool whose side effect genuinely completed before the crash can be
  recovered by polling the provider's own run status; a tool with no
  `reconcile()` has no way back and the run ends ambiguous — an
  accepted limitation for today's fixture tool (synchronous, no real
  external run) and an explicit, now-documented **requirement** for any
  real Magica tool registered in Phase 3, not an assumption.
- **After execution but before the result is persisted** (narrowed by
  the lifecycle hardening above, but not eliminated — a window of one
  `await` still exists between `execute()` returning and the update
  committing): if the process dies in exactly this window, the
  `ToolInvocation` stays `RUNNING` and the same re-entry path as
  "during execution" applies. For a tool with no `reconcile()`, a
  genuinely-completed-but-unpersisted result is lost from the system's
  perspective (durable only as "this ran and we don't know the
  outcome," never silently re-run). Eliminating this window entirely
  would need wrapping a tool's own side effect and its persistence in
  one atomic unit — not possible in general for a real external
  provider call, and out of this checkpoint's scope to attempt.

**What is safe to retry, stated plainly:** re-invoking `executeAgentTurn`
for the same `agentRunId` is always safe, at any point, any number of
times — every code path either makes forward progress exactly once
(guarded by a CAS, a unique constraint, or the liveness check) or backs
off without writing anything. Nothing in this design ever automatically
retries a tool's `execute()` call itself; the only "retry" that exists
is Trigger.dev's own task-level retry of the *orchestration*, which
this re-entry logic was built to make safe to repeat indefinitely.

## Application-owned skills system (checkpoint 2.5)

**Decision A amended, narrowly.** `PRODUCTION_TOOL_REGISTRY` stopped
being empty — it now contains exactly `load_skill` and
`read_skill_asset`. Both are local-only (no external provider call, no
credit charge, no business side effect), registered because this
checkpoint's own instructions required it. Magica/business tools
remain deferred to Phase 3; this is not a general reopening of
Decision A. One consequence worth naming plainly: every real production
call to OpenRouter now sends these two tool definitions (previously,
with an empty registry, `tools` was omitted from the request entirely)
— `send-turn.test.ts`'s pre-existing live end-to-end test therefore now
exercises a real conversation that *can* see live tool-calling for the
first time, not only the plain-text path checkpoints 2.1–2.4 verified.

### Skill bundle format
`agent-skills/<skill-name>/SKILL.md`, optionally with supporting files
(e.g. `guides/*.md`) in subdirectories. `SKILL.md` requires YAML
frontmatter with `name` (lowercase kebab-case, 2–64 chars) and
`description` (1–500 chars), followed by the skill's instructions body
in Markdown. Three real, non-placeholder skills ship: `image-editing`
(crop/generative-edit planning, with a `guides/composition.md`
supporting file), `video-editing` (merge/sequencing planning),
`image-analysis` (description/quality-check planning). Content is
guidance text only — asset files are restricted to `.md`; nothing a
skill ships is executable, and nothing in the loader ever executes
skill content as code.

### Registry and discovery (`src/skills/registry.ts`)
`discoverSkills(rootDir)` walks the directory once, validates every
bundle's frontmatter (Zod), rejects empty/oversized `SKILL.md` files
(32KB cap), and rejects a duplicate declared `name` across different
directories — collecting *every* problem found before throwing one
aggregated `SkillDiscoveryError`, so a bad startup state is loud and
actionable, never a silent partial registration. A *supporting asset's*
own problems (wrong extension, oversized, a symlink that escapes the
skill directory) only exclude that one asset from the approved set —
they don't fail the whole skill, unlike a problem in `SKILL.md` itself.
`PRODUCTION_SKILL_REGISTRY` is an eager singleton built from the real
`agent-skills/` directory at module load — "discover at application
startup," literally, mirroring `PRODUCTION_TOOL_REGISTRY`'s own
pattern. `listSkillMetadata(registry)` exposes only `name` +
`description`, sorted, for every registered skill — never a skill's
body or its real filesystem directory.

### Agent prompt integration (`src/skills/prompt.ts`)
`executeAgentTurn` now takes a fourth dependency-injected parameter,
`skillRegistry` (default `PRODUCTION_SKILL_REGISTRY` — same pattern as
`registry`/`publish`), and prepends one synthesized `system` message —
built fresh every entry from `buildSkillSystemPrompt(listSkillMetadata(...))`,
never persisted as a `Message` — to `history` before the loop. It lists
every registered skill's name and description and explains when to call
`load_skill`/`read_skill_asset`; it never contains a skill's
instructions body. A skill's actual instructions only reach the model
once `load_skill` is called for it — returned as an ordinary tool
result, flowing back into context through the *existing*
`turnMessages` mechanism from checkpoint 2.3, no new orchestration
branch.

### `load_skill` / `read_skill_asset` contracts (`src/tools/skills.ts`)
Both are ordinary `ToolDefinition`s built by a small factory
(`createLoadSkillTool(skillRegistry)` / `createReadSkillAssetTool(skillRegistry)`)
so tests can bind them to a fixture registry instead of the real
`agent-skills/` directory — the production singletons
(`loadSkillTool`/`readSkillAssetTool`) bind to `PRODUCTION_SKILL_REGISTRY`.
Everything about validation, persistence, and the Zod input/output
boundary flows through the *existing* tool-execution mechanism
(`runOneToolCall` in `run-agent-turn.ts`) unchanged — no special
skill-execution branch was added to the agent loop.

- **`load_skill({ name })`** → `{ name, description, instructions,
  contentHash, previouslyLoaded }`. Unknown name → a plain thrown
  `Error` ("No skill named ..."), which the existing mechanism turns
  into an ordinary `FAILED`/`EXECUTION_FAILED` `ToolInvocation` — a
  model-hallucinated skill name fails exactly like a model-hallucinated
  tool name already does, no new error path. On success, persists (or
  confirms) a `RunSkill` row keyed by `(agentRunId, skillName)`.
- **`read_skill_asset({ skillName, assetPath })`** → `{ skillName,
  assetPath, content, contentHash }`. Requires the skill to already be
  loaded for *this* `AgentRun` — checked against the durable `RunSkill`
  row, not an in-memory flag, so it holds identically whether this is
  the same execution continuing or a fresh process re-entering after a
  crash. `assetPath` is resolved via `resolveApprovedAsset` (below);
  any failure (unknown skill, unknown/unapproved asset, not-yet-loaded
  skill) is a uniform rejection message — never which specific check
  failed.

### Security boundaries (`src/skills/paths.ts`)
`read_skill_asset` never calls `path.resolve()` on the caller's raw
input against the filesystem. Instead: (1) the requested path is
normalized (percent-decoded first, so an encoded traversal attempt is
caught by the same check as a literal one) and must exactly match a key
already present in that skill's `assets` map — a map built entirely
from a safe, realpath-contained directory walk at discovery time. This
alone defeats every traversal/absolute-path/encoded-path attempt,
since none of those strings can ever equal a legitimately-discovered
relative path — "unknown asset," not a path-resolution outcome. (2)
Even for a map hit, the file is re-resolved via `fs.realpathSync` and
re-checked against the skill's own realpath'd directory *again*, right
before reading — closing the gap where a file could be replaced or
symlinked after startup (TOCTOU), not trusting the discovery-time cache
alone. Extension (`.md` only) and size (64KB cap) are re-checked at
this same point. No tool, skill, or asset can read outside its own
skill directory, execute code, read environment variables, or see raw
filesystem paths — tool outputs only ever carry the relative path the
caller asked for.

### Durable persistence and resume behavior
`RunSkill(agentRunId, skillName, contentHash)`, unique on
`(agentRunId, skillName)` — see DATABASE.md. `load_skill`'s own logic:
no existing row → insert, `previouslyLoaded: false`; an existing row
with a matching `contentHash` → return the same cached values,
`previouslyLoaded: true`, no new row (checkpoint requirement:
"repeated loading returns the same persisted version"); an existing row
whose `contentHash` does **not** match the registry's *current* hash
for that skill (only possible across a process restart/redeploy that
changed the skill's file between this run's first load and a later
retry/re-entry) → throws a clear, structured `Error` naming both
hashes, refusing to silently serve the new content in the old load's
place. A concurrent duplicate insert (two racing calls for the same
`agentRunId`+`skillName`) is caught via the same unique constraint,
re-reads the row that landed, and returns it rather than erroring —
verified with a real `Promise.all` of two concurrent `execute()` calls,
not just reasoned about, same rigor as checkpoint 2.4's concurrency
test. "Restore on retry/resume" is this DB row being authoritative, not
an in-memory replay of prior tool-call history — the model simply calls
`load_skill` again if it needs the instructions again, and the contract
guarantees it always gets back the identical version.

### Known limitations, stated plainly
- Supporting assets are restricted to `.md` text files only — no
  binary/image asset representation is implemented (narrower than the
  "supported asset representation" language in the brief; this
  checkpoint's actual three skills only need Markdown).
- An already-loaded skill's full instructions are **not** automatically
  re-injected into the base system prompt on a later round or after
  re-entry — only name+description are ever in the base prompt; a model
  that needs the instructions again simply calls `load_skill` again
  (cheap, local, idempotent). This was a deliberate simplicity choice
  over a second mechanism that would risk the exact thing the brief
  warns against ("do not load every skill's full content into every
  model request") at scale across many loaded skills.
- No live OpenRouter call was used to verify a model actually chooses to
  call `load_skill` for a relevant prompt — all progressive-loading
  tests mock `callOpenRouter`, per this checkpoint's own "no live
  OpenRouter/Magica calls" instruction. The first genuine live exercise
  of this path is whatever real conversation happens to trigger it
  after this checkpoint ships (see the "one consequence worth naming"
  note at the top of this section).

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
