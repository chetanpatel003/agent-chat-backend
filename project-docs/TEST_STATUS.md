# TEST_STATUS — actual results

| Check | Last run | Result |
|---|---|---|
| `pnpm typecheck` | checkpoint 1.1 | PASS |
| `pnpm lint` | checkpoint 1.1 | PASS (no issues) |
| `pnpm test` (Vitest) | checkpoint 1.1 | FAIL — "No test files found" (expected, none written yet) |
| `prisma validate` | checkpoint 1.1 | PASS |
| `prisma migrate status` | checkpoint 1.1 | PASS — "Database schema is up to date" |
| Functional: one-active-run-per-chat constraint | checkpoint 1.1 | PASS — duplicate active run rejected (23505), terminal+active coexist, verified then rolled back |
| `pnpm typecheck` | checkpoint 1.2 | PASS |
| `pnpm lint` | checkpoint 1.2 | PASS (no issues) |
| `pnpm test` (Vitest) | checkpoint 1.2 | **PASS — 27/27** (5 files: contracts message/pagination, services auth/ownership, route /me) |
| Real HTTP smoke test (dev server) | checkpoint 1.2 | PASS — `/api/v1/me` 401 with no token and with a real-but-invalid token (live Clerk verification, not mocked); CORS preflight returns the configured `FRONTEND_ORIGIN` |

**Coverage by checkpoint 1.2's required test list:** missing token ✓, invalid token ✓, valid authenticated user ✓, existing local user lookup ✓, local user creation ✓, concurrent local user resolution ✓ (caught a real bug — see decisions/0007), frontend-supplied user id ignored ✓, cross-user chat ownership rejection ✓, invalid Zod payloads ✓ (content blocks + pagination), valid/invalid pagination cursors ✓, message content-block validation ✓.

Update this table (don't narrate) after each phase's test step.
