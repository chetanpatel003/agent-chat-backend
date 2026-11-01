# 0009 — Verified P2002 error shape for the partial unique index

Checkpoint 2.1's send-turn service needs to distinguish two different
`AgentRun` unique-constraint violations and handle each differently:
- `AgentRun_one_active_per_chat` (the raw-SQL partial index) → a
  **different** send while a run is already active → 409 Conflict.
- `AgentRun_idempotencyKey_key` (the plain `@unique` field) → the
  **same** send retried → idempotent replay, re-read and return the
  existing run, not an error.

Empirically verified (not assumed) against the real DB via a throwaway
probe script, since Prisma's P2002 `meta` shape for a driver-adapter
client isn't the plain `{ target: string[] }` shape older Prisma
versions use:

```
error.code === "P2002"
error.meta.driverAdapterError.cause.constraint.index
  // "AgentRun_one_active_per_chat" | "AgentRun_idempotencyKey_key"
```

`send-turn.ts`'s catch block should branch on
`error.meta?.driverAdapterError?.cause?.constraint?.index`, not on
`error.meta?.target` (which older Prisma/standard-field guidance would
suggest, and which does not hold for this adapter-based client against
a raw-SQL index).
