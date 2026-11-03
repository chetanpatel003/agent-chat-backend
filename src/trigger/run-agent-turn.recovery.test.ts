import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/providers/openrouter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/providers/openrouter")>();
  return { ...actual, callOpenRouter: vi.fn() };
});

import { callOpenRouter, OpenRouterDefiniteError, type CallOpenRouterOptions } from "@/providers/openrouter";
import { prisma } from "@/lib/prisma";
import { makeTestUser, cleanupTestUsers } from "@/test-utils/db-fixtures";
import { createToolRegistry } from "@/tools/registry";
import type { PublishRunEvent } from "@/realtime/publish-run-event";
import { RUN_TRANSITION_TRANSACTION_OPTIONS } from "@/services/run-transitions";
import { sweepStaleRuns, STALE_ACTIVE_RUN_THRESHOLD_MS } from "@/services/stale-run-recovery";
import { executeAgentTurn, type TurnRuntime } from "./run-agent-turn";

// Regression for the stuck-run bug seen in browser verification (decisions/0016):
// definite provider error → failure transaction couldn't start → attempt threw →
// the retry's re-entry backed off as "recently active" and completed → the
// AgentRun stayed RUNNING forever with an empty PENDING message.

const mockCallOpenRouter = vi.mocked(callOpenRouter);
const createdUserIds: string[] = [];
const noopPublish: PublishRunEvent = () => {};
const runtime: TurnRuntime = {
  openTextStream: () => ({ write: () => {}, close: async () => {} }),
  waitpoints: {
    createToken: () => Promise.reject(new Error("unused")),
    forToken: () => Promise.reject(new Error("unused")),
  },
};

beforeEach(() => {
  mockCallOpenRouter.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(() => cleanupTestUsers(createdUserIds));

async function setUpRun(label: string) {
  const owner = await makeTestUser(label);
  createdUserIds.push(owner.id);
  const chat = await prisma.chat.create({ data: { userId: owner.id } });
  const triggerRunId = `run_test_${randomUUID()}`;
  const run = await prisma.agentRun.create({
    data: { chatId: chat.id, userId: owner.id, idempotencyKey: randomUUID(), status: "QUEUED", triggerRunId },
  });
  await prisma.message.create({
    data: { chatId: chat.id, userId: owner.id, agentRunId: run.id, role: "USER", status: "COMPLETE", content: [{ type: "text", text: "hi" }] },
  });
  return { run, triggerRunId };
}

/** Streams "Partial " then, past the 1 s flush interval, "answer", then fails definitively. */
function streamThenFail() {
  return async (_m: unknown, _t: unknown, options?: CallOpenRouterOptions) => {
    await options?.onTextDelta?.("Partial ");
    await new Promise((r) => setTimeout(r, 1100));
    await options?.onTextDelta?.("answer"); // this delta's flush persists "Partial answer"
    throw new OpenRouterDefiniteError("Upstream unavailable", "PROVIDER_UNAVAILABLE", "Partial answer");
  };
}

/** The observed infrastructure failure: the run-failure transaction cannot start. */
function failFirstTransaction() {
  const original = prisma.$transaction.bind(prisma);
  let failed = false;
  const calls: unknown[][] = [];
  const spy = vi.spyOn(prisma, "$transaction").mockImplementation(((...args: unknown[]) => {
    calls.push(args);
    if (!failed) {
      failed = true;
      return Promise.reject(new Error("Transaction API error: Unable to start a transaction in the given time."));
    }
    return (original as (...a: unknown[]) => unknown)(...args);
  }) as typeof prisma.$transaction);
  return { spy, calls };
}

async function backdate(agentRunId: string, ageMs: number) {
  await prisma.$executeRaw`UPDATE "AgentRun" SET "updatedAt" = ${new Date(Date.now() - ageMs)} WHERE "id" = ${agentRunId}::uuid`;
}

const assistant = (runId: string) => prisma.message.findFirstOrThrow({ where: { agentRunId: runId, role: "ASSISTANT" } });

describe("stuck-run regression: failure persistence fails, then the retry recovers", () => {
  it("a retry attempt of the owning Trigger.dev run finalizes at once — no backing off, no second provider call, partial text kept", async () => {
    const { run, triggerRunId } = await setUpRun("stuck-retry-recovers");
    mockCallOpenRouter.mockImplementationOnce(streamThenFail());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { calls } = failFirstTransaction();

    // Attempt 1: the provider fails definitively; persisting that fails; the attempt throws.
    await expect(
      executeAgentTurn({ agentRunId: run.id }, createToolRegistry([]), noopPublish, undefined, runtime, { triggerRunId, attempt: 1 }),
    ).rejects.toThrow(/Unable to start a transaction/);
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("RUNNING");
    // The run-failure transaction was attempted with the run-transition options.
    expect(calls[0][1]).toEqual(RUN_TRANSITION_TRANSACTION_OPTIONS);

    // The provider code was logged before the failed write — without the partial text or provider message.
    const logged = warn.mock.calls.find(([msg]) => msg === "Provider call failed");
    expect(logged?.[1]).toMatchObject({ agentRunId: run.id, code: "PROVIDER_UNAVAILABLE", partialTextChars: 14 });
    expect(JSON.stringify(logged)).not.toMatch(/Partial answer|Upstream unavailable/);

    // Attempt 2, seconds later (inside the 120 s liveness window): previously this skipped forever.
    const result = await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([]), noopPublish, undefined, runtime, {
      triggerRunId,
      attempt: 2,
    });
    expect(result).toMatchObject({ status: "FAILED", ambiguous: true });
    expect(mockCallOpenRouter).toHaveBeenCalledTimes(1); // never re-asked

    const final = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(final).toMatchObject({ status: "FAILED", errorCode: "AMBIGUOUS_PROVIDER_OUTCOME" });
    const message = await assistant(run.id);
    expect(message.content).toEqual([{ type: "text", text: "Partial answer" }]); // flushed partial text preserved
  }, 60_000);

  it("a different execution (not a retry of the owning run) still backs off inside the liveness window", async () => {
    const { run, triggerRunId } = await setUpRun("stuck-other-execution");
    mockCallOpenRouter.mockImplementationOnce(streamThenFail());
    vi.spyOn(console, "warn").mockImplementation(() => {});
    failFirstTransaction();
    await expect(
      executeAgentTurn({ agentRunId: run.id }, createToolRegistry([]), noopPublish, undefined, runtime, { triggerRunId, attempt: 1 }),
    ).rejects.toThrow();

    for (const execution of [undefined, { triggerRunId: "run_someone_else", attempt: 2 }, { triggerRunId, attempt: 1 }]) {
      const result = await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([]), noopPublish, undefined, runtime, execution);
      expect(result).toMatchObject({ status: "RUNNING", skipped: true });
    }
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("RUNNING");
  }, 60_000);

  it("if the retry also backs off (e.g. no execution info), the stale-run sweep eventually recovers the run", async () => {
    const { run, triggerRunId } = await setUpRun("stuck-sweep-recovers");
    mockCallOpenRouter.mockImplementationOnce(streamThenFail());
    vi.spyOn(console, "warn").mockImplementation(() => {});
    failFirstTransaction();
    await expect(
      executeAgentTurn({ agentRunId: run.id }, createToolRegistry([]), noopPublish, undefined, runtime, { triggerRunId, attempt: 1 }),
    ).rejects.toThrow();
    // The observed outcome: the retry skipped and Trigger.dev recorded the run COMPLETED.
    expect(await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([]), noopPublish, undefined, runtime)).toMatchObject({
      skipped: true,
    });

    await backdate(run.id, STALE_ACTIVE_RUN_THRESHOLD_MS + 60_000);
    const summary = await sweepStaleRuns({
      triggerRunStatus: async (id) => (id === triggerRunId ? "COMPLETED" : "EXECUTING"),
    });
    expect(summary.recovered).toBe(1);
    expect(mockCallOpenRouter).toHaveBeenCalledTimes(1);

    const final = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(final).toMatchObject({ status: "FAILED", errorCode: "RUN_INTERRUPTED" });
    expect((await assistant(run.id)).content).toEqual([{ type: "text", text: "Partial answer" }]);
  }, 60_000);
});
