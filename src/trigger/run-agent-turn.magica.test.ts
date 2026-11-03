import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/providers/openrouter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/providers/openrouter")>();
  return { ...actual, callOpenRouter: vi.fn() };
});
vi.mock("@/providers/magica", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/providers/magica")>();
  return { ...actual, startMagicaRun: vi.fn(), getMagicaRun: vi.fn() };
});
vi.mock("@/services/magica-run", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/magica-run")>();
  return { ...actual, persistProviderRunId: vi.fn(actual.persistProviderRunId) };
});

import { callOpenRouter, type ProviderToolCall } from "@/providers/openrouter";
import { startMagicaRun, getMagicaRun } from "@/providers/magica";
import { persistProviderRunId } from "@/services/magica-run";
import { prisma } from "@/lib/prisma";
import { makeTestUser, cleanupTestUsers } from "@/test-utils/db-fixtures";
import { createToolRegistry } from "@/tools/registry";
import { createMagicaFixtureTool, MAGICA_FIXTURE_TOOL_NAME } from "@/test-utils/magica-fixture-tool";
import type { PublishRunEvent } from "@/realtime/publish-run-event";
import { executeAgentTurn } from "./run-agent-turn";

/**
 * Checkpoint 3.2 — integration tests exercising the real Magica start/
 * persist/poll/reconcile machinery through the real `executeAgentTurn`/
 * `runOneToolCall` loop, using `magicaFixtureTool` (never registered in
 * `PRODUCTION_TOOL_REGISTRY`). Kept in its own file, separate from
 * `run-agent-turn.test.ts`, purely for size — it's already large.
 */

const mockCallOpenRouter = vi.mocked(callOpenRouter);
const mockStartMagicaRun = vi.mocked(startMagicaRun);
const mockGetMagicaRun = vi.mocked(getMagicaRun);
const mockPersistProviderRunId = vi.mocked(persistProviderRunId);
const createdUserIds: string[] = [];

const noopPublish: PublishRunEvent = vi.fn().mockResolvedValue(undefined);
const noopWait = vi.fn().mockResolvedValue(undefined);

function toolCall(name: string, args: Record<string, unknown> | string, id = randomUUID()): ProviderToolCall {
  return { id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } };
}
function finalAnswer(text: string) {
  return { model: "x/y:free", text, toolCalls: null, promptTokens: 1, completionTokens: 1 };
}
function toolRequest(calls: ProviderToolCall[], text: string | null = null) {
  return { model: "x/y:free", text, toolCalls: calls, promptTokens: 1, completionTokens: 1 };
}

beforeEach(() => {
  mockCallOpenRouter.mockReset();
  mockStartMagicaRun.mockReset();
  mockGetMagicaRun.mockReset();
  noopWait.mockClear();
  // .mockClear(), not .mockReset() — this mock's default implementation
  // calls through to the real persistProviderRunId (see the vi.mock
  // factory above); only the one test that cares overrides it
  // per-call with .mockResolvedValueOnce.
  mockPersistProviderRunId.mockClear();
});
afterAll(() => cleanupTestUsers(createdUserIds));

async function user(label: string) {
  const u = await makeTestUser(label);
  createdUserIds.push(u.id);
  return u;
}

async function setUpRun(owner: { id: string }) {
  const chat = await prisma.chat.create({ data: { userId: owner.id } });
  const run = await prisma.agentRun.create({
    data: { chatId: chat.id, userId: owner.id, idempotencyKey: randomUUID(), status: "QUEUED" },
  });
  await prisma.message.create({
    data: { chatId: chat.id, userId: owner.id, agentRunId: run.id, role: "USER", status: "COMPLETE", content: [{ type: "text", text: "hi" }] },
  });
  return { chat, run };
}

function pollResult(overrides: Partial<Record<string, unknown>> = {}) {
  return { id: "x", nodeType: "magica_test_node", status: "RUNNING", createdAt: "2026-01-01T00:00:00Z", ...overrides };
}

describe("executeAgentTurn — Magica tool: start, persist, poll (happy path)", () => {
  it("starts once, persists providerRunId before polling, and completes with the real output", async () => {
    const owner = await user("magica-happy-path");
    const { run } = await setUpRun(owner);
    const registry = createToolRegistry([createMagicaFixtureTool(noopWait)]);
    const call = toolCall(MAGICA_FIXTURE_TOOL_NAME, { prompt: "a cat" });

    mockCallOpenRouter.mockResolvedValueOnce(toolRequest([call]));
    mockCallOpenRouter.mockResolvedValueOnce(finalAnswer("done"));
    mockStartMagicaRun.mockResolvedValueOnce({ runId: "magica_run_happy" });
    mockGetMagicaRun.mockResolvedValueOnce(pollResult({ status: "COMPLETED", output: { ok: true } }));

    const result = await executeAgentTurn({ agentRunId: run.id }, registry, noopPublish);
    expect(result.status).toBe("COMPLETED");
    expect(mockStartMagicaRun).toHaveBeenCalledTimes(1);

    const invocation = await prisma.toolInvocation.findFirstOrThrow({ where: { agentRunId: run.id } });
    expect(invocation.status).toBe("COMPLETED");
    expect(invocation.providerRunId).toBe("magica_run_happy");
    expect(invocation.output).toEqual({ result: { ok: true } });
  });

  it("uses the correct invocation when multiple tool calls share one AgentRun — never confuses them by agentRunId alone", async () => {
    const owner = await user("magica-multi-invocation");
    const { run } = await setUpRun(owner);
    const registry = createToolRegistry([createMagicaFixtureTool(noopWait)]);
    const callA = toolCall(MAGICA_FIXTURE_TOOL_NAME, { prompt: "first" });
    const callB = toolCall(MAGICA_FIXTURE_TOOL_NAME, { prompt: "second" });

    mockCallOpenRouter.mockResolvedValueOnce(toolRequest([callA, callB]));
    mockCallOpenRouter.mockResolvedValueOnce(finalAnswer("done"));
    mockStartMagicaRun.mockResolvedValueOnce({ runId: "magica_run_a" }).mockResolvedValueOnce({ runId: "magica_run_b" });
    mockGetMagicaRun
      .mockResolvedValueOnce(pollResult({ status: "COMPLETED", output: { which: "a" } }))
      .mockResolvedValueOnce(pollResult({ status: "COMPLETED", output: { which: "b" } }));

    const result = await executeAgentTurn({ agentRunId: run.id }, registry, noopPublish);
    expect(result.status).toBe("COMPLETED");

    const invocations = await prisma.toolInvocation.findMany({ where: { agentRunId: run.id }, orderBy: { createdAt: "asc" } });
    expect(invocations).toHaveLength(2);
    expect(invocations[0].providerRunId).toBe("magica_run_a");
    expect(invocations[0].output).toEqual({ result: { which: "a" } });
    expect(invocations[1].providerRunId).toBe("magica_run_b");
    expect(invocations[1].output).toEqual({ result: { which: "b" } });
  });
});

describe("executeAgentTurn — Magica start-request failure policy", () => {
  it("an ambiguous start (network/5xx-style) never triggers automatic resubmission within the same call", async () => {
    const owner = await user("magica-ambiguous-start");
    const { run } = await setUpRun(owner);
    const registry = createToolRegistry([createMagicaFixtureTool(noopWait)]);
    const call = toolCall(MAGICA_FIXTURE_TOOL_NAME, { prompt: "x" });

    mockCallOpenRouter.mockResolvedValueOnce(toolRequest([call]));
    mockCallOpenRouter.mockResolvedValueOnce(finalAnswer("done"));
    const { MagicaAmbiguousError } = await import("@/providers/magica");
    mockStartMagicaRun.mockRejectedValueOnce(new MagicaAmbiguousError("HTTP 500", "MAGICA_START_AMBIGUOUS_5XX"));

    await executeAgentTurn({ agentRunId: run.id }, registry, noopPublish);
    expect(mockStartMagicaRun).toHaveBeenCalledTimes(1);

    const invocation = await prisma.toolInvocation.findFirstOrThrow({ where: { agentRunId: run.id } });
    expect(invocation.status).toBe("FAILED");
    expect(invocation.providerRunId).toBeNull();
  });

  it("a 202 followed by a persistence failure never triggers another start — the tool call fails cleanly instead", async () => {
    const owner = await user("magica-persist-conflict");
    const { run } = await setUpRun(owner);
    const registry = createToolRegistry([createMagicaFixtureTool(noopWait)]);
    const call = toolCall(MAGICA_FIXTURE_TOOL_NAME, { prompt: "x" });

    mockCallOpenRouter.mockResolvedValueOnce(toolRequest([call]));
    mockCallOpenRouter.mockResolvedValueOnce(finalAnswer("done"));
    mockStartMagicaRun.mockResolvedValueOnce({ runId: "magica_run_conflict" });
    // Force the persistence step specifically to fail, as if a
    // concurrent writer had already claimed a different value —
    // already proven at the unit level in magica-run.test.ts; this
    // proves the *integration* consequence: the tool call fails
    // cleanly (EXECUTION_FAILED, the existing mechanism) and
    // startMagicaRun is never called a second time because of it.
    mockPersistProviderRunId.mockResolvedValueOnce({ applied: false, currentProviderRunId: "something-else" });

    const result = await executeAgentTurn({ agentRunId: run.id }, registry, noopPublish);
    expect(result.status).toBe("COMPLETED"); // the turn still reaches a final answer; only the tool call failed
    expect(mockStartMagicaRun).toHaveBeenCalledTimes(1);
    expect(mockGetMagicaRun).not.toHaveBeenCalled(); // never reaches polling

    const invocation = await prisma.toolInvocation.findFirstOrThrow({ where: { agentRunId: run.id } });
    expect(invocation.status).toBe("FAILED");
    expect(invocation.errorCode).toBe("EXECUTION_FAILED");
  });

  it("HTTP 4xx/429-style definite start rejection is recorded as a failure and never automatically retried", async () => {
    const owner = await user("magica-definite-start-rejection");
    const { run } = await setUpRun(owner);
    const registry = createToolRegistry([createMagicaFixtureTool(noopWait)]);
    const call = toolCall(MAGICA_FIXTURE_TOOL_NAME, { prompt: "x" });

    mockCallOpenRouter.mockResolvedValueOnce(toolRequest([call]));
    mockCallOpenRouter.mockResolvedValueOnce(finalAnswer("done"));
    const { MagicaDefiniteError } = await import("@/providers/magica");
    mockStartMagicaRun.mockRejectedValueOnce(new MagicaDefiniteError("rate limited", "RATE_LIMITED"));

    await executeAgentTurn({ agentRunId: run.id }, registry, noopPublish);
    expect(mockStartMagicaRun).toHaveBeenCalledTimes(1);

    const invocation = await prisma.toolInvocation.findFirstOrThrow({ where: { agentRunId: run.id } });
    expect(invocation.status).toBe("FAILED");
  });
});

describe("executeAgentTurn — Magica polling: timeout/budget never starts another run", () => {
  it("exhausting the polling budget leaves the invocation RUNNING (not FAILED) and the AgentRun backs off without touching anything — never starts another run", async () => {
    const owner = await user("magica-poll-budget");
    const { run } = await setUpRun(owner);
    const registry = createToolRegistry([createMagicaFixtureTool(noopWait)]);
    const call = toolCall(MAGICA_FIXTURE_TOOL_NAME, { prompt: "x" });

    mockCallOpenRouter.mockResolvedValueOnce(toolRequest([call]));
    mockStartMagicaRun.mockResolvedValueOnce({ runId: "magica_run_slow" });
    mockGetMagicaRun.mockResolvedValue(pollResult({ status: "RUNNING" }));

    const result = await executeAgentTurn({ agentRunId: run.id }, registry, noopPublish);
    expect(result.skipped).toBe(true);
    expect(result.ambiguous).toBe(false);
    expect(mockStartMagicaRun).toHaveBeenCalledTimes(1);

    const invocation = await prisma.toolInvocation.findFirstOrThrow({ where: { agentRunId: run.id } });
    expect(invocation.status).toBe("RUNNING");
    expect(invocation.providerRunId).toBe("magica_run_slow");

    const updatedRun = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(updatedRun.status).toBe("RUNNING"); // nothing was finalized
  }, 40000);
});

describe("executeAgentTurn — Magica reconciliation on re-entry", () => {
  it("a completed remote run discovered by reconcile() is persisted onto the ToolInvocation; the AgentRun still ends ambiguous (no OpenRouter resumption)", async () => {
    const owner = await user("magica-reconcile-completed");
    const { chat, run } = await setUpRun(owner);
    await prisma.agentRun.update({ where: { id: run.id }, data: { status: "RUNNING", startedAt: new Date() } });
    await prisma.message.create({
      data: { chatId: chat.id, userId: owner.id, agentRunId: run.id, role: "ASSISTANT", status: "PENDING", content: [] },
    });
    const stale = await prisma.toolInvocation.create({
      data: { agentRunId: run.id, toolName: MAGICA_FIXTURE_TOOL_NAME, idempotencyKey: randomUUID(), input: {}, status: "RUNNING", providerRunId: `magica_run_reentry_${randomUUID()}` },
    });
    await prisma.$executeRaw`UPDATE "AgentRun" SET "updatedAt" = ${new Date(Date.now() - 5 * 60_000)} WHERE "id" = ${run.id}::uuid`;

    mockGetMagicaRun.mockResolvedValueOnce(pollResult({ status: "COMPLETED", output: { recovered: true } }));
    const registry = createToolRegistry([createMagicaFixtureTool(noopWait)]);

    const result = await executeAgentTurn({ agentRunId: run.id }, registry, noopPublish);
    expect(result.ambiguous).toBe(true);
    expect(mockStartMagicaRun).not.toHaveBeenCalled();
    expect(mockCallOpenRouter).not.toHaveBeenCalled();

    const updatedInvocation = await prisma.toolInvocation.findUniqueOrThrow({ where: { id: stale.id } });
    expect(updatedInvocation.status).toBe("COMPLETED");
    expect(updatedInvocation.output).toEqual({ result: { recovered: true } });
  });

  it("a failed/canceled remote run discovered by reconcile() is persisted as FAILED, not left RUNNING", async () => {
    const owner = await user("magica-reconcile-failed");
    const { chat, run } = await setUpRun(owner);
    await prisma.agentRun.update({ where: { id: run.id }, data: { status: "RUNNING", startedAt: new Date() } });
    await prisma.message.create({
      data: { chatId: chat.id, userId: owner.id, agentRunId: run.id, role: "ASSISTANT", status: "PENDING", content: [] },
    });
    const stale = await prisma.toolInvocation.create({
      data: { agentRunId: run.id, toolName: MAGICA_FIXTURE_TOOL_NAME, idempotencyKey: randomUUID(), input: {}, status: "RUNNING", providerRunId: "magica_run_reentry_fail" },
    });
    await prisma.$executeRaw`UPDATE "AgentRun" SET "updatedAt" = ${new Date(Date.now() - 5 * 60_000)} WHERE "id" = ${run.id}::uuid`;

    mockGetMagicaRun.mockResolvedValueOnce(pollResult({ status: "FAILED", userMessage: "bad prompt" }));
    const registry = createToolRegistry([createMagicaFixtureTool(noopWait)]);

    await executeAgentTurn({ agentRunId: run.id }, registry, noopPublish);
    expect(mockStartMagicaRun).not.toHaveBeenCalled();

    const updatedInvocation = await prisma.toolInvocation.findUniqueOrThrow({ where: { id: stale.id } });
    expect(updatedInvocation.status).toBe("FAILED");
    expect(updatedInvocation.errorMessage).toBe("bad prompt");
  });

  it("a still-inconclusive reconciliation preserves the invocation as RUNNING — never overwrites it, never starts a new run", async () => {
    const owner = await user("magica-reconcile-inconclusive");
    const { chat, run } = await setUpRun(owner);
    await prisma.agentRun.update({ where: { id: run.id }, data: { status: "RUNNING", startedAt: new Date() } });
    await prisma.message.create({
      data: { chatId: chat.id, userId: owner.id, agentRunId: run.id, role: "ASSISTANT", status: "PENDING", content: [] },
    });
    const stale = await prisma.toolInvocation.create({
      data: { agentRunId: run.id, toolName: MAGICA_FIXTURE_TOOL_NAME, idempotencyKey: randomUUID(), input: {}, status: "RUNNING", providerRunId: "magica_run_still_going" },
    });
    await prisma.$executeRaw`UPDATE "AgentRun" SET "updatedAt" = ${new Date(Date.now() - 5 * 60_000)} WHERE "id" = ${run.id}::uuid`;

    mockGetMagicaRun.mockResolvedValue(pollResult({ status: "RUNNING" }));
    const registry = createToolRegistry([createMagicaFixtureTool(noopWait)]);

    await executeAgentTurn({ agentRunId: run.id }, registry, noopPublish);
    expect(mockStartMagicaRun).not.toHaveBeenCalled();

    const updatedInvocation = await prisma.toolInvocation.findUniqueOrThrow({ where: { id: stale.id } });
    expect(updatedInvocation.status).toBe("RUNNING");
    expect(updatedInvocation.providerRunId).toBe("magica_run_still_going");
  }, 40000);

  it("a missing providerRunId during reconciliation never starts a new run — the one case this checkpoint explicitly cannot recover", async () => {
    const owner = await user("magica-reconcile-missing-provider-run-id");
    const { chat, run } = await setUpRun(owner);
    await prisma.agentRun.update({ where: { id: run.id }, data: { status: "RUNNING", startedAt: new Date() } });
    await prisma.message.create({
      data: { chatId: chat.id, userId: owner.id, agentRunId: run.id, role: "ASSISTANT", status: "PENDING", content: [] },
    });
    const stale = await prisma.toolInvocation.create({
      data: { agentRunId: run.id, toolName: MAGICA_FIXTURE_TOOL_NAME, idempotencyKey: randomUUID(), input: {}, status: "RUNNING" },
    });
    await prisma.$executeRaw`UPDATE "AgentRun" SET "updatedAt" = ${new Date(Date.now() - 5 * 60_000)} WHERE "id" = ${run.id}::uuid`;

    const registry = createToolRegistry([createMagicaFixtureTool(noopWait)]);
    await executeAgentTurn({ agentRunId: run.id }, registry, noopPublish);

    expect(mockStartMagicaRun).not.toHaveBeenCalled();
    expect(mockGetMagicaRun).not.toHaveBeenCalled();
    const updatedInvocation = await prisma.toolInvocation.findUniqueOrThrow({ where: { id: stale.id } });
    expect(updatedInvocation.status).toBe("RUNNING");
    expect(updatedInvocation.providerRunId).toBeNull();
  });

  it("never overwrites an already-terminal invocation (defensive: a sibling already finalized it)", async () => {
    const owner = await user("magica-reconcile-terminal-guard");
    const { chat, run } = await setUpRun(owner);
    await prisma.agentRun.update({ where: { id: run.id }, data: { status: "RUNNING", startedAt: new Date() } });
    await prisma.message.create({
      data: { chatId: chat.id, userId: owner.id, agentRunId: run.id, role: "ASSISTANT", status: "PENDING", content: [] },
    });
    // Already COMPLETED by the time reconcile would run — not found by
    // the `status: "RUNNING"` re-entry query at all, proving the guard
    // structurally: the stale-invocation branch never even fires.
    await prisma.toolInvocation.create({
      data: {
        agentRunId: run.id,
        toolName: MAGICA_FIXTURE_TOOL_NAME,
        idempotencyKey: randomUUID(),
        input: {},
        status: "COMPLETED",
        providerRunId: "magica_run_already_done",
        output: { result: { already: "done" } },
      },
    });
    await prisma.$executeRaw`UPDATE "AgentRun" SET "updatedAt" = ${new Date(Date.now() - 5 * 60_000)} WHERE "id" = ${run.id}::uuid`;
    mockCallOpenRouter.mockResolvedValueOnce(finalAnswer("done"));

    const registry = createToolRegistry([createMagicaFixtureTool(noopWait)]);
    const result = await executeAgentTurn({ agentRunId: run.id }, registry, noopPublish);

    // With no RUNNING ToolInvocation and no PENDING message mismatch...
    // actually the message IS still PENDING here (never finalized) —
    // this still hits the ambiguous-outcome path, which is correct:
    // the message itself was never completed even though the tool was.
    expect(mockStartMagicaRun).not.toHaveBeenCalled();
    expect(mockGetMagicaRun).not.toHaveBeenCalled();
    expect(result.skipped || result.ambiguous).toBeTruthy();
  });
});
