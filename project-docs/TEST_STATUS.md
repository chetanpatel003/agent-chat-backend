# TEST_STATUS — actual results

| Check | Last run | Result |
|---|---|---|
| `pnpm typecheck` | checkpoint 1.1 | PASS |
| `pnpm lint` | checkpoint 1.1 | PASS (no issues) |
| `pnpm test` (Vitest) | checkpoint 1.1 | FAIL — "No test files found" (expected, none written yet) |
| `prisma validate` | checkpoint 1.1 | PASS |
| `prisma migrate status` | checkpoint 1.1 | PASS — "Database schema is up to date" |
| Functional: one-active-run-per-chat constraint | checkpoint 1.1 | PASS — duplicate active run rejected (23505), terminal+active coexist, verified then rolled back |

Update this table (don't narrate) after each phase's test step.
