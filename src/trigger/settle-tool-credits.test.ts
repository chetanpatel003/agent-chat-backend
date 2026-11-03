import { describe, it, expect, vi, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";

// Settlement never calls Magica: any provider call fails the test.
vi.mock("@/providers/magica", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/providers/magica")>();
  return {
    ...actual,
    startMagicaRun: vi.fn(() => Promise.reject(new Error("Magica must not be called"))),
    getMagicaRun: vi.fn(() => Promise.reject(new Error("Magica must not be called"))),
  };
});

import { startMagicaRun, getMagicaRun } from "@/providers/magica";
import { prisma } from "@/lib/prisma";
import { makeTestUser, cleanupTestUsers } from "@/test-utils/db-fixtures";
import { settlementIdempotencyKey } from "@/services/credit-settlement";
import {
  dispatchCreditSettlement,
  runToolCreditSettlement,
  SETTLEMENT_RETRY,
  settlementTaskIdempotencyKey,
  settleToolCredits,
} from "./settle-tool-credits";

// Trigger.dev is mocked by spying on the task's `trigger`; its retry engine
// is simulated by re-running the task body once per attempt.

const createdUserIds: string[] = [];
afterAll(() => cleanupTestUsers(createdUserIds));
afterEach(() => {
  vi.restoreAllMocks();
  expect(startMagicaRun).not.toHaveBeenCalled();
  expect(getMagicaRun).not.toHaveBeenCalled();
});

async function terminalInvocation(label: string, runStatus: "RUNNING" | "COMPLETED" | "FAILED" = "RUNNING") {
  const user = await makeTestUser(label);
  createdUserIds.push(user.id);
  await prisma.creditAccount.create({ data: { userId: user.id, balance: BigInt(1_000_000) } });
  const chat = await prisma.chat.create({ data: { userId: user.id } });
  const run = await prisma.agentRun.create({
    data: { chatId: chat.id, userId: user.id, idempotencyKey: randomUUID(), status: runStatus },
  });
  const invocation = await prisma.toolInvocation.create({
    data: {
      agentRunId: run.id,
      toolName: "generate_image",
      idempotencyKey: randomUUID(),
      input: {},
      status: "COMPLETED",
      output: { images: ["https://x/a.png"], creditUsed: 68_484 },
    },
  });
  return { user, run, invocation };
}

const ledgerCount = (toolInvocationId: string) => prisma.creditLedger.count({ where: { toolInvocationId } });

describe("settle-tool-credits task", () => {
  it("is bounded: at most 5 attempts with capped backoff", () => {
    expect(SETTLEMENT_RETRY).toEqual({ maxAttempts: 5, factor: 2, minTimeoutInMs: 2_000, maxTimeoutInMs: 60_000, randomize: true });
  });

  it("settles after the parent AgentRun is already terminal", async () => {
    const { user, invocation } = await terminalInvocation("stl-terminal-parent", "COMPLETED");
    expect(await runToolCreditSettlement({ toolInvocationId: invocation.id })).toMatchObject({ status: "settled" });
    expect((await prisma.creditAccount.findUniqueOrThrow({ where: { userId: user.id } })).balance).toBe(BigInt(931_516));
  });

  it("retries a transient database failure and settles exactly once on a later attempt", async () => {
    const { invocation } = await terminalInvocation("stl-transient");
    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("connection reset"));

    await expect(runToolCreditSettlement({ toolInvocationId: invocation.id })).rejects.toThrow("connection reset");
    expect((await prisma.toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } })).creditsCharged).toBeNull();

    expect(await runToolCreditSettlement({ toolInvocationId: invocation.id })).toMatchObject({ status: "settled" });
    expect(await ledgerCount(invocation.id)).toBe(1);
  });

  it("is idempotent across repeated executions of the same job", async () => {
    const { invocation } = await terminalInvocation("stl-repeat");
    await runToolCreditSettlement({ toolInvocationId: invocation.id });
    expect(await runToolCreditSettlement({ toolInvocationId: invocation.id })).toEqual({ status: "already_settled" });
    expect(await ledgerCount(invocation.id)).toBe(1);
  });

  it("charges once when the durable task and the inline attempt race", async () => {
    const { invocation } = await terminalInvocation("stl-race");
    await Promise.all([
      runToolCreditSettlement({ toolInvocationId: invocation.id }),
      runToolCreditSettlement({ toolInvocationId: invocation.id }),
    ]);
    expect(await ledgerCount(invocation.id)).toBe(1);
  });

  it("rejects a malformed payload", async () => {
    await expect(runToolCreditSettlement({ toolInvocationId: "nope" })).rejects.toThrow();
  });
});

describe("dispatchCreditSettlement", () => {
  it("uses a deterministic per-invocation idempotency key", async () => {
    const id = randomUUID();
    const trigger = vi.spyOn(settleToolCredits, "trigger").mockResolvedValue({ id: "run_fake" } as never);
    expect(await dispatchCreditSettlement(id)).toBe(true);
    expect(await dispatchCreditSettlement(id)).toBe(true);
    for (const call of trigger.mock.calls) {
      expect(call[0]).toEqual({ toolInvocationId: id });
      expect(call[1]).toMatchObject({ idempotencyKey: `settle-tool-credits:${id}`, idempotencyKeyTTL: "24h" });
    }
    expect(settlementTaskIdempotencyKey(id)).not.toBe(settlementIdempotencyKey(id));
  });

  it("logs a dispatch failure without throwing", async () => {
    vi.spyOn(settleToolCredits, "trigger").mockRejectedValue(new Error("Trigger.dev unavailable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const id = randomUUID();
    expect(await dispatchCreditSettlement(id)).toBe(false);
    expect(log).toHaveBeenCalledWith("Credit settlement dispatch failed", expect.objectContaining({ toolInvocationId: id }));
  });
});
