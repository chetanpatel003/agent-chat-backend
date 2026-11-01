# 0011 — Tool-calling request/response shape taken from docs, not a live call

Checkpoint 2.2's response-shape verification (decisions/0010) was done
with two real, live `openrouter/free` calls. Checkpoint 2.3 deliberately
did **not** repeat that pattern for the tool-calling shapes (`tools` on
the request, `tool_calls`/`finish_reason: "tool_calls"` on the response,
the `tool` message role) — doing so would mean sending a real tool
definition into a real conversation, which the checkpoint's own scope
explicitly excludes ("do not expose the fixture tool to real
conversations").

Instead, the shapes are taken from OpenRouter's documented OpenAI-
compatible schema (`/docs/api-reference/chat-completion`):

- Request: `tools: [{ type: "function", function: { name, description,
  parameters } }]`, `parameters` being a JSON Schema object.
- Response: `choices[0].message.tool_calls: [{ id, type: "function",
  function: { name, arguments: "<JSON string>" } }]`,
  `finish_reason: "tool_calls"`.
- Tool result sent back as `{ role: "tool", tool_call_id, content:
  "<string>" }` — no `name` field, unlike user/system/assistant messages.

This is a well-established, extremely stable schema shared by virtually
every OpenAI-compatible provider, so the risk of it being wrong is low —
but it is explicitly **not independently verified against OpenRouter's
real API** the way decisions/0010's plain-text shapes were. The first
genuine exercise of this path against the real API happens in Phase 3,
when real Magica tools are registered into the same mechanism and used
in an actual conversation.

**Consequence for this checkpoint's test coverage:** `openrouter.test.ts`
and `run-agent-turn.test.ts` test against this documented shape via MSW
fixtures and mocks, not a live response. If OpenRouter's real behavior
diverges from the docs in some edge case, that will surface when Phase 3
registers a real tool — not before.
