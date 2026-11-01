import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/providers/magica", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/providers/magica")>();
  return { ...actual, getMagicaRun: vi.fn(), startMagicaRun: vi.fn() };
});

import { getMagicaRun, startMagicaRun } from "@/providers/magica";
import { prisma } from "@/lib/prisma";
import { makeTestUser, cleanupTestUsers } from "@/test-utils/db-fixtures";
import {
  persistProviderRunId,
  pollMagicaRunToCompletion,
  reconcileMagicaRun,
  MAGICA_POLL_MAX_ATTEMPTS,
  type DurableWait,
} from "./magica-run";

const mockGetMagicaRun = vi.mocked(getMagicaRun);
const mockStartMagicaRun = vi.mocked(startMagicaRun);
const createdUserIds: string[] = [];

beforeEach(() => {
  mockGetMagicaRun.mockReset();
  mockStartMagicaRun.mockReset();
});
afterAll(() => cleanupTestUsers(createdUserIds));

async function user(label: string) {
  const u = await makeTestUser(label);
  createdUserIds.push(u.id);
  return u;
}

async function setUpRunAndInvocation(ownerId: string, status: "RUNNING" | "COMPLETED" = "RUNNING") {
  const chat = await prisma.chat.create({ data: { userId: ownerId } });
  const run = await prisma.agentRun.create({
    data: { chatId: chat.id, userId: ownerId, idempotencyKey: randomUUID(), status: "RUNNING" },
  });
  const invocation = await prisma.toolInvocation.create({
    data: { agentRunId: run.id, toolName: "magica_test_tool", idempotencyKey: randomUUID(), input: {}, status },
  });
  return { run, invocation };
}

function pollResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "run_x",
    nodeType: "magica_test_node",
    status: "RUNNING",
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const noopWait: DurableWait = vi.fn().mockResolvedValue(undefined);

describe("persistProviderRunId", () => {
  it("persists providerRunId onto a RUNNING invocation", async () => {
    const owner = await user("persist-ok");
    const { invocation } = await setUpRunAndInvocation(owner.id);

    const runId = `magica_run_${randomUUID()}`;
    const result = await persistProviderRunId(invocation.id, runId);
    expect(result).toEqual({ applied: true });

    const updated = await prisma.toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } });
    expect(updated.providerRunId).toBe(runId);
  });

  it("is idempotent for a repeat of the exact same value", async () => {
    const owner = await user("persist-repeat-same");
    const { invocation } = await setUpRunAndInvocation(owner.id);
    const runId = `magica_run_${randomUUID()}`;
    await persistProviderRunId(invocation.id, runId);

    const second = await persistProviderRunId(invocation.id, runId);
    expect(second).toEqual({ applied: true });
  });

  it("refuses to overwrite an existing providerRunId with a different value", async () => {
    const owner = await user("persist-conflict");
    const { invocation } = await setUpRunAndInvocation(owner.id);
    const firstRunId = `magica_run_${randomUUID()}`;
    const secondRunId = `magica_run_${randomUUID()}`;
    await persistProviderRunId(invocation.id, firstRunId);

    const result = await persistProviderRunId(invocation.id, secondRunId);
    expect(result).toEqual({ applied: false, currentProviderRunId: firstRunId });

    const unchanged = await prisma.toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } });
    expect(unchanged.providerRunId).toBe(firstRunId);
  });

  it("does not apply when the invocation is no longer RUNNING", async () => {
    const owner = await user("persist-not-running");
    const { invocation } = await setUpRunAndInvocation(owner.id, "COMPLETED");

    const result = await persistProviderRunId(invocation.id, `magica_run_${randomUUID()}`);
    expect(result.applied).toBe(false);
  });
});

describe("pollMagicaRunToCompletion", () => {
  it("returns the completed outcome with raw output", async () => {
    const owner = await user("poll-completed");
    const { run } = await setUpRunAndInvocation(owner.id);
    mockGetMagicaRun.mockResolvedValueOnce(pollResult({ status: "COMPLETED", output: { images: ["x"] } }));

    const outcome = await pollMagicaRunToCompletion({ agentRunId: run.id, providerRunId: "r1", waitFn: noopWait });
    expect(outcome).toEqual({ status: "completed", output: { images: ["x"] } });
  });

  it("returns a normalized failure for FAILED", async () => {
    const owner = await user("poll-failed");
    const { run } = await setUpRunAndInvocation(owner.id);
    mockGetMagicaRun.mockResolvedValueOnce(pollResult({ status: "FAILED", userMessage: "bad input" }));

    const outcome = await pollMagicaRunToCompletion({ agentRunId: run.id, providerRunId: "r1", waitFn: noopWait });
    expect(outcome).toEqual({ status: "failed", errorCode: "MAGICA_RUN_FAILED", errorMessage: "bad input" });
  });

  it("returns a normalized failure for CANCELED", async () => {
    const owner = await user("poll-canceled");
    const { run } = await setUpRunAndInvocation(owner.id);
    mockGetMagicaRun.mockResolvedValueOnce(pollResult({ status: "CANCELED" }));

    const outcome = await pollMagicaRunToCompletion({ agentRunId: run.id, providerRunId: "r1", waitFn: noopWait });
    expect(outcome.status).toBe("failed");
    expect((outcome as { errorCode: string }).errorCode).toBe("MAGICA_RUN_CANCELED");
  });

  it("keeps polling (using the injected wait) through QUEUED/RUNNING until a terminal status", async () => {
    const owner = await user("poll-pending-then-done");
    const { run } = await setUpRunAndInvocation(owner.id);
    mockGetMagicaRun
      .mockResolvedValueOnce(pollResult({ status: "QUEUED" }))
      .mockResolvedValueOnce(pollResult({ status: "RUNNING" }))
      .mockResolvedValueOnce(pollResult({ status: "COMPLETED", output: { ok: true } }));
    const waitSpy = vi.fn().mockResolvedValue(undefined);

    const outcome = await pollMagicaRunToCompletion({ agentRunId: run.id, providerRunId: "r1", waitFn: waitSpy });
    expect(outcome).toEqual({ status: "completed", output: { ok: true } });
    expect(mockGetMagicaRun).toHaveBeenCalledTimes(3);
    expect(waitSpy).toHaveBeenCalledTimes(2);
  });

  it("keeps polling through an unrecognized/unknown status rather than treating it as failed or completed", async () => {
    const owner = await user("poll-unknown-status");
    const { run } = await setUpRunAndInvocation(owner.id);
    mockGetMagicaRun
      .mockResolvedValueOnce(pollResult({ status: "SOMETHING_NEW" }))
      .mockResolvedValueOnce(pollResult({ status: "COMPLETED", output: {} }));

    const outcome = await pollMagicaRunToCompletion({ agentRunId: run.id, providerRunId: "r1", waitFn: noopWait });
    expect(outcome.status).toBe("completed");
    expect(mockGetMagicaRun).toHaveBeenCalledTimes(2);
  });

  it("retries a transient poll failure rather than failing the run", async () => {
    const owner = await user("poll-transient-error");
    const { run } = await setUpRunAndInvocation(owner.id);
    mockGetMagicaRun
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValueOnce(pollResult({ status: "COMPLETED", output: {} }));

    const outcome = await pollMagicaRunToCompletion({ agentRunId: run.id, providerRunId: "r1", waitFn: noopWait });
    expect(outcome.status).toBe("completed");
  });

  it(
    "throws MagicaPollInconclusiveError once the attempt-count budget is exhausted — never submits another run itself",
    async () => {
      const owner = await user("poll-budget-exhausted");
      const { run } = await setUpRunAndInvocation(owner.id);
      mockGetMagicaRun.mockResolvedValue(pollResult({ status: "RUNNING" }));

      await expect(
        pollMagicaRunToCompletion({ agentRunId: run.id, providerRunId: "r1", waitFn: noopWait }),
      ).rejects.toMatchObject({ name: "MagicaPollInconclusiveError" });
      expect(mockGetMagicaRun).toHaveBeenCalledTimes(MAGICA_POLL_MAX_ATTEMPTS);
      expect(mockStartMagicaRun).not.toHaveBeenCalled();
    },
    // 60 attempts means 60 real readAgentRunStatus round trips to Neon —
    // comfortably exceeds Vitest's default 5s/this suite's 20s budget
    // under this session's observed Neon latency; same reasoning as
    // the turn-limit test's own raised timeout in run-agent-turn.test.ts.
    40000,
  );

  it("stops polling promptly (without claiming Magica itself stopped) once the local AgentRun is no longer RUNNING", async () => {
    const owner = await user("poll-local-cancel");
    const { run } = await setUpRunAndInvocation(owner.id);
    await prisma.agentRun.update({ where: { id: run.id }, data: { status: "CANCELLED" } });

    await expect(
      pollMagicaRunToCompletion({ agentRunId: run.id, providerRunId: "r1", waitFn: noopWait }),
    ).rejects.toMatchObject({ name: "MagicaPollInconclusiveError" });
    expect(mockGetMagicaRun).not.toHaveBeenCalled();
  });
});

describe("reconcileMagicaRun", () => {
  it("polls using the persisted providerRunId and never calls the start endpoint", async () => {
    const owner = await user("reconcile-ok");
    const { invocation } = await setUpRunAndInvocation(owner.id);
    await persistProviderRunId(invocation.id, "magica_run_persisted");
    mockGetMagicaRun.mockResolvedValueOnce(pollResult({ status: "COMPLETED", output: { done: true } }));

    const outcome = await reconcileMagicaRun({ id: invocation.id, providerRunId: "magica_run_persisted" }, noopWait);
    expect(outcome).toEqual({ status: "completed", output: { done: true } });
    expect(mockGetMagicaRun).toHaveBeenCalledWith("magica_run_persisted");
    expect(mockStartMagicaRun).not.toHaveBeenCalled();
  });

  it("never starts a new run when providerRunId is missing — throws MagicaPollInconclusiveError instead", async () => {
    const owner = await user("reconcile-missing-provider-run-id");
    const { invocation } = await setUpRunAndInvocation(owner.id);

    await expect(reconcileMagicaRun({ id: invocation.id, providerRunId: null }, noopWait)).rejects.toMatchObject({
      name: "MagicaPollInconclusiveError",
    });
    expect(mockGetMagicaRun).not.toHaveBeenCalled();
    expect(mockStartMagicaRun).not.toHaveBeenCalled();
  });
});
