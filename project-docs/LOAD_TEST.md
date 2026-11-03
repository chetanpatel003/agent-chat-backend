# Bounded load test (2026-11-03)

Harness: `src/load/agent-load.test.ts` (skipped unless `RUN_LOAD_TEST=1`).
```sh
RUN_LOAD_TEST=1 LOAD_LEVELS=10,25,50 pnpm vitest run src/load/agent-load.test.ts
```

**What is real:** one Node 22 process, the shared Neon dev database (remote, ~300 ms round trip
from this machine), Prisma 7 with `@prisma/adapter-pg` (pool max 10), every transaction, unique
index and guarded transition. **What is mocked:** Trigger.dev dispatch and the model (OpenRouter;
a fixed 200 ms simulated latency, a quarter of turns failing). Not measured: Trigger.dev queueing
and worker concurrency, OpenRouter, Vercel, production infrastructure. **1,000 concurrent turns
was not tested.**

## Results

| Scenario | Concurrency | Outcome | Wall | Throughput | Latency p50 / p95 |
|---|---|---|---|---|---|
| Admission (N chats) | 10 | 10/10 | 2.5 s | 4.1 /s | 2.4 / 2.5 s |
| | 25 | 25/25 | 5.9 s | 4.2 /s | 5.1 / 5.8 s |
| | 50 | 50/50 | 11.6 s | 4.3 /s | 10.8 / 11.6 s |
| | 100 | **60/100** (40 × pool timeout) | 17.4 s | 3.4 /s | 15.8 / 17.3 s |
| One chat, distinct keys | 10 / 25 / 50 / 100 | exactly 1 run, N−1 × 409 | | | 7.4 / 10.5 s at 50 |
| One chat, same key | 10 / 25 / 50 / 100 | 1 run, every success returns it (98/100 at 100) | | | |
| Full turns (25 % failing) | 10 | 7 completed, 3 failed, isolated | 6.1 s | 1.6 /s | 6.1 / 6.1 s |
| | 25 | 18 / 7, isolated | 13.8 s | 1.8 /s | 11.8 / 13.4 s |
| | 50 | 37 / 13, isolated | 28.0 s | 1.8 /s | 24.1 / 27.8 s |

Realtime events per turn: 5 (run_status, step, thinking_completed, assistant_message, run_status).
Process memory stayed flat (RSS deltas within ±90 MB, no growth across levels).

## Pool-size follow-up (same day)
The pool size is now configurable (`DATABASE_POOL_MAX`, 1–50, default 10; `src/lib/prisma.ts`).

| Pool | Scenario | Concurrency | Outcome | Wall | Throughput | p50 / p95 |
|---|---|---|---|---|---|---|
| 25 | Admission | 50 / 100 | 50/50, **100/100** | 4.6 / 8.9 s | 11.0 / 11.3 /s | 8.2 / 8.8 s at 100 |
| 25 | Contention | 100 | 1 run, 99 × 409; same key → 1 run | | | 6.0 / 8.5 s |
| 25 | Full turns | 50 / 100 | all completed or failed as designed, isolated | 12.1 / 23.1 s | 4.1 / 4.3 /s | 20.5 / 22.8 s at 100 |
| 40 | Admission | 200 | **200/200** | 11.1 s | 18.0 /s | 10.3 / 11.0 s |
| 40 | Contention | 200 | 1 run, 199 × 409; same key → 1 run (200/200) | | | 7.5 / 10.1 s |
| 40 | Full turns | 200 | 150 completed, 50 failed (the injected quarter), isolated | 27.2 s | 7.3 /s | 23.6 / 26.9 s |

Throughput scales roughly with the pool (10 → 25 → 40 connections: 4.2 → 11.3 → 18 admissions/s),
confirming the bottleneck is connection count × remote round-trip latency, not application logic.
Scaling stopped at 200 because the test shares the development database. 1,000 was not run.

## Findings
- **Correctness held at every level**: one active run per chat, idempotency, and failure isolation
  (no failing turn affected another) — including at 100 concurrent requests.
- **Throughput is flat (~4.2 admissions/s, ~1.8 turns/s) and set by the pool, not the code**:
  10 connections × (1 / ~2.4 s of sequential remote round trips per admission) ≈ 4.2 /s.
- **Overload behaviour**: at 100 concurrent admissions in one process, 40 transactions waited past
  the 10 s `maxWait` and failed cleanly (nothing written). These now return **503 ServiceBusy**
  (retryable) instead of a generic 500 (`src/lib/errors.ts`).

## What 1,000 concurrent turns would need (not verified)
Admission and turns are stateless per request; capacity scales with processes and database
connections, not with this code. On the target platform, each Vercel function instance and each
Trigger.dev run has its own pool; Neon's pooled endpoint (PgBouncer) multiplexes them. The limits to
plan for are the database's connection/CPU budget, Trigger.dev concurrency (plan-dependent), and
the OpenRouter free tier's request limits — the last makes 1,000 concurrent *real* turns impossible
on free plans regardless of this application.
