# 0007 — prisma.user.upsert() is not safe under concurrency

**Finding (checkpoint 1.2, caught by the concurrent-resolution test):** Prisma's
`upsert()` is not a single atomic `INSERT ... ON CONFLICT`. It emulates the
check-then-act itself. Two concurrent `upsert()` calls racing to create the
same new row can both pass the check and one throws a real
`PrismaClientKnownRequestError` (P2002) instead of resolving gracefully.
The original design doc's claim that upsert alone made user resolution
race-safe was wrong — confirmed by a real failing test, not assumed.

**Fix:** `resolveLocalUser()` uses `create()` directly and catches P2002;
the loser of the race re-reads the row the winner created with
`findUnique()`. Postgres's unique constraint on `clerkUserId` is the actual
safety mechanism — Prisma's upsert was never that mechanism to begin with.

**Consequence:** any other "find-or-create" path added later (e.g. a
CreditAccount auto-provisioned on first use) should use this same
create-then-catch-P2002 pattern, not `upsert()`, if it can be reached
concurrently for the same unique key.
