// Bounded load harness — skipped unless RUN_LOAD_TEST=1.
//   RUN_LOAD_TEST=1 LOAD_LEVELS=10,25,50 pnpm vitest run src/load/agent-load.test.ts
// Real database (shared Neon dev instance, Prisma pool max 10), real
// transactions and constraints. Mocked: Trigger.dev dispatch and the model
// (OpenRouter) — no provider is called. Measures what this process + database
// do under concurrency; it does NOT measure Trigger.dev queueing, OpenRouter,
// or production infrastructure.
import { describe, it, expect, vi, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/trigger/run-agent-turn", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/trigger/run-agent-turn")>();
  return { ...actual, runAgentTurn: { trigger: vi.fn(async () => ({ id: `run_load_${randomUUID()}` })) } };
});
vi.mock("@/providers/openrouter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/providers/openrouter")>();
  return { ...actual, callOpenRouter: vi.fn() };
});

import { callOpenRouter, OpenRouterDefiniteError } from "@/providers/openrouter";
import { prisma } from "@/lib/prisma";
import { ConflictError } from "@/lib/errors";
import { makeTestUser, cleanupTestUsers } from "@/test-utils/db-fixtures";
import { createToolRegistry } from "@/tools/registry";
import { sendTurn } from "@/services/send-turn";
import { executeAgentTurn, type TurnRuntime } from "@/trigger/run-agent-turn";

const enabled = process.env.RUN_LOAD_TEST === "1";
const LEVELS = (process.env.LOAD_LEVELS ?? "10,25,50").split(",").map(Number);
const createdUserIds: string[] = [];
afterAll(() => cleanupTestUsers(createdUserIds));

// Title generation is dispatched after every first message; never let a test reach Trigger.dev through it.
vi.mock("@/trigger/generate-chat-title", () => ({ dispatchChatTitle: vi.fn().mockResolvedValue(true) }));
const runtime: TurnRuntime = {
  openTextStream: () => ({ write: () => {}, close: async () => {} }),
  waitpoints: { createToken: () => Promise.reject(new Error("unused")), forToken: () => Promise.reject(new Error("unused")) },
  webhooks: async () => {},
};

function stats(ms: number[]) {
  const sorted = [...ms].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return { p50: Math.round(at(50)), p95: Math.round(at(95)), max: Math.round(sorted.at(-1) ?? 0) };
}

async function timed<T>(fn: () => Promise<T>) {
  const start = performance.now();
  try {
    return { ok: true as const, value: await fn(), ms: performance.now() - start };
  } catch (error) {
    return { ok: false as const, error, ms: performance.now() - start };
  }
}

const report: Record<string, unknown>[] = [];
const log = (row: Record<string, unknown>) => {
  report.push(row);
  process.stdout.write(`LOAD ${JSON.stringify(row)}\n`);
};

describe.skipIf(!enabled)("bounded load (mocked providers)", () => {
  it("admission: N concurrent sends into N chats", async () => {
    const owner = await makeTestUser("load-admission");
    createdUserIds.push(owner.id);
    for (const n of LEVELS) {
      const chats = await Promise.all(Array.from({ length: n }, () => prisma.chat.create({ data: { userId: owner.id } })));
      const rss0 = process.memoryUsage().rss;
      const start = performance.now();
      const results = await Promise.all(chats.map((chat) => timed(() => sendTurn(owner.id, chat.id, randomUUID(), { text: "hi" }))));
      const wall = performance.now() - start;
      const ok = results.filter((r) => r.ok);
      log({
        scenario: "admission",
        concurrency: n,
        ok: ok.length,
        failed: n - ok.length,
        wallMs: Math.round(wall),
        perSec: Number(((ok.length / wall) * 1000).toFixed(1)),
        latencyMs: stats(results.map((r) => r.ms)),
        rssDeltaMb: Math.round((process.memoryUsage().rss - rss0) / 1e6),
      });
      expect(ok.length).toBe(n);
    }
  }, 600_000);

  it("contention: one chat, N concurrent sends → exactly one active run; same key → one run", async () => {
    const owner = await makeTestUser("load-contention");
    createdUserIds.push(owner.id);
    for (const n of LEVELS) {
      const chat = await prisma.chat.create({ data: { userId: owner.id } });
      const results = await Promise.all(Array.from({ length: n }, () => timed(() => sendTurn(owner.id, chat.id, randomUUID(), { text: "hi" }))));
      const conflicts = results.filter((r) => !r.ok && r.error instanceof ConflictError).length;
      const runs = await prisma.agentRun.count({ where: { chatId: chat.id } });

      const sameKeyChat = await prisma.chat.create({ data: { userId: owner.id } });
      const key = randomUUID();
      const same = await Promise.all(Array.from({ length: n }, () => timed(() => sendTurn(owner.id, sameKeyChat.id, key, { text: "hi" }))));
      const sameRuns = await prisma.agentRun.count({ where: { chatId: sameKeyChat.id } });
      const sameIds = new Set(same.filter((r) => r.ok).map((r) => (r.ok ? r.value.runId : "")));
      log({
        scenario: "contention",
        concurrency: n,
        distinctKeys: { succeeded: results.filter((r) => r.ok).length, conflicts, runsCreated: runs },
        sameKey: { succeeded: same.filter((r) => r.ok).length, runsCreated: sameRuns, distinctRunIds: sameIds.size },
        latencyMs: stats([...results, ...same].map((r) => r.ms)),
      });
      expect(runs).toBe(1);
      expect(conflicts).toBe(n - 1);
      expect(sameRuns).toBe(1);
      expect(sameIds.size).toBe(1);
    }
  }, 600_000);

  it("full turns: N concurrent agent turns, a quarter failing, mocked model", async () => {
    const owner = await makeTestUser("load-turns");
    createdUserIds.push(owner.id);
    vi.mocked(callOpenRouter).mockImplementation(async (messages) => {
      const text = String(messages.at(-1)?.content ?? "");
      if (text.includes("fail")) throw new OpenRouterDefiniteError("simulated provider error", "PROVIDER_UNAVAILABLE");
      await new Promise((r) => setTimeout(r, 200)); // simulated model latency (no network)
      return { model: "load/mock:free", text: "ok", toolCalls: null, promptTokens: 1, completionTokens: 1 };
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const n of LEVELS) {
      const runs = await Promise.all(
        Array.from({ length: n }, async (_, i) => {
          const chat = await prisma.chat.create({ data: { userId: owner.id } });
          const sent = await sendTurn(owner.id, chat.id, randomUUID(), { text: i % 4 === 0 ? "please fail" : "hello" });
          return { runId: sent.runId, shouldFail: i % 4 === 0 };
        }),
      );
      let events = 0;
      const publish = () => void events++;
      const rss0 = process.memoryUsage().rss;
      const start = performance.now();
      const results = await Promise.all(
        runs.map((r) => timed(() => executeAgentTurn({ agentRunId: r.runId }, createToolRegistry([]), publish, undefined, runtime))),
      );
      const wall = performance.now() - start;
      const outcomes = await prisma.agentRun.findMany({ where: { id: { in: runs.map((r) => r.runId) } }, select: { id: true, status: true } });
      const byId = new Map(outcomes.map((o) => [o.id, o.status]));
      const isolated = runs.every((r) => byId.get(r.runId) === (r.shouldFail ? "FAILED" : "COMPLETED"));
      log({
        scenario: "turns",
        concurrency: n,
        threw: results.filter((r) => !r.ok).length,
        completed: outcomes.filter((o) => o.status === "COMPLETED").length,
        failed: outcomes.filter((o) => o.status === "FAILED").length,
        failureIsolation: isolated,
        wallMs: Math.round(wall),
        turnsPerSec: Number(((n / wall) * 1000).toFixed(1)),
        latencyMs: stats(results.map((r) => r.ms)),
        realtimeEvents: events,
        rssDeltaMb: Math.round((process.memoryUsage().rss - rss0) / 1e6),
      });
      expect(isolated).toBe(true);
    }
  }, 900_000);
});
