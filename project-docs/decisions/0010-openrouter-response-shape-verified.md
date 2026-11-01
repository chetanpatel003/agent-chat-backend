# 0010 — OpenRouter free-route response shape, verified live

The official docs don't say whether the response's `model` field reflects
the actual routed model versus the literal `"openrouter/free"` alias, and
don't mention a `reasoning` field separate from `content`. Both are
load-bearing for the adapter's design, so verified against two real,
live `openrouter/free` calls (free tier, cost confirmed `0` in the
response) rather than guessed:

**`model` genuinely varies per request and is never the literal alias.**
Call 1 returned `nvidia/nemotron-3.5-lightning:free`; call 2 (same
request shape) returned `nvidia/nemotron-3.5-super-vl:free`. Confirms:
the adapter must record the response's own `model`, and can validate a
real free route by checking it ends in `:free` — the requested model
name is never proof of the actual route, exactly per the checkpoint's
instruction.

**`content` can be `null` while `reasoning` carries the actual output.**
With a small `max_completion_tokens`, call 1 spent its entire budget on
`reasoning` and returned `content: null`, `finish_reason: "length"`. With
a larger budget, call 2 returned both: `reasoning` (the model's working)
and `content: "pong"` (the final answer), `finish_reason: "stop"`.
Consequence: the adapter must handle `content: null` without crashing,
and must only treat a response as unusable (`EMPTY_RESPONSE`) when
*neither* field has anything — not when `content` alone is empty.

**Design decisions this verification fixed, not invented:**
- `max_completion_tokens: 2048` (not the earlier too-small test value) —
  prevents a real conversation from truncating into an empty `content`
  the way the first probe call did.
- The model's `reasoning` is mapped to a `thinking` content block, its
  `content` to a `text` block — but `conversation-context.ts` only
  re-sends `text` blocks as context on later turns, never `thinking` —
  the model's own scratch reasoning isn't re-injected as if it were
  prior dialogue. (Caught as a real inconsistency while writing tests:
  the task wrote `type: "thinking"`, the context builder's filter
  originally looked for `type: "reasoning"` — fixed to the correct,
  deliberate behavior above, not just made consistent arbitrarily.)

No further live calls are part of the automated test suite — `openrouter.test.ts`
uses MSW with response fixtures modeled exactly on these two real
responses. These two calls are the "one controlled live OpenRouter Free
connectivity test" this checkpoint calls for.
