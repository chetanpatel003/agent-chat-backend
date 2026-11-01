# 0001 — Backend is a separate Next.js app of Route Handlers only

**Decision:** two repos; backend is Next.js App Router, API-only, Route Handlers as the REST layer.
**Why:** assessment requires both "two separate repos" and "Next.js Route Handlers" — ambiguous how they combine. This satisfies both literally.
**Condition (evaluator-confirmed):** backend independently verifies Clerk tokens and enforces ownership on every request — never trusts the frontend.
**Status:** confirmed by evaluator, twice.
