# 0012 — `wait.for()` requires a live task context; a 5000ms charge threshold gates real checkpointing

Checkpoint 3.2 needed Trigger.dev's durable-wait primitive for Magica
polling. Two claims below were verified by reading the installed
`@trigger.dev/sdk@4.8.3` package's actual runtime source
(`dist/esm/v3/wait.js`), not assumed from the docs' "durable wait"
framing or from the type declarations alone.

## 1. `wait.for()` throws outside a live task context

```js
for: async (options) => {
    const ctx = taskContext.ctx;
    if (!ctx) {
        throw new Error("wait.forToken can only be used from inside a task.run()");
    }
    ...
```

Confirmed directly in the shipped source. This is the same category of
problem checkpoint 2.4 found with `metadata.append()` ("Method not
implemented" outside a live task). **Consequence:** `wait.for()` cannot
be called directly from a Vitest test process — `src/services/magica-
run.ts`'s polling functions take an injectable `waitFn` (default: the
real `wait.for`), the same dependency-injection pattern already used
for the tool registry, the realtime publisher, and the skill registry.
Tests inject a fast no-op instead of needing a live task context.

## 2. Waits of 5000ms or less do not checkpoint — confirmed from source, not assumed

```js
const DURATION_WAIT_CHARGE_THRESHOLD_MS = 5000;
...
if (durationInMs <= DURATION_WAIT_CHARGE_THRESHOLD_MS) {
    // plain in-process setTimeout — the task process stays alive,
    // billed as compute time, no platform-level suspend happens
    ...
    await new Promise((resolve) => setTimeout(resolve, durationInMs));
}
// only a wait LONGER than 5000ms reaches the real checkpoint path:
const result = await apiClient.waitForDuration(ctx.run.id, { date, ... });
await runtime.waitUntil(result.waitpoint.id, date);
```

A `wait.for({ seconds: 5 })` call or shorter is **not** a durable
checkpoint — it's an ordinary `setTimeout`, with the task process held
open and billed the whole time. Only a wait strictly longer than 5000ms
reaches the platform's real suspend/resume path (independently
corroborated by the run-engine's own schema,
`@trigger.dev/core/.../schemas/checkpoints.d.ts`, which defines real
`SUSPENDED`/`EXECUTING_WITH_WAITPOINTS` execution-status values for
exactly this path).

**Consequence:** `MAGICA_POLL_INTERVAL_SECONDS` is set to `10` (not a
smaller, more tempting value like `5`) in `src/services/magica-run.ts`
specifically so every poll-wait clears the threshold with margin and
genuinely checkpoints, rather than silently degrading into a resource-
holding busy-wait that happens to look identical in code.

## Why this matters for Phase 3.2's design

Both findings directly shaped `src/services/magica-run.ts`: the DI
`waitFn` parameter exists *because of* finding 1 (it's the only way to
unit-test the polling loop at all), and the chosen interval exists
*because of* finding 2 (choosing 5s or less would have made the whole
"durable wait" design claim false in practice, even though it would
have looked identical in the code and passed every test that mocks
`waitFn` away). Neither was guessed — both came from reading the
actual shipped implementation after the type declarations alone proved
insufficient to answer either question.
