import { describe, it, expect, vi, beforeEach, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";

// Recovery must never start a Magica run; status reads are mocked per test.
vi.mock("@/providers/magica", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/providers/magica")>();
  return {
    ...actual,
    startMagicaRun: vi.fn(() => Promise.reject(new Error("Magica start must never be called by recovery"))),
    getMagicaRun: vi.fn(),
  };
});

import { getMagicaRun, startMagicaRun, MagicaAmbiguousError } from "@/providers/magica";
import { prisma } from "@/lib/prisma";
import { makeTestUser, cleanupTestUsers } from "@/test-utils/db-fixtures";
import { createToolRegistry } from "@/tools/registry";
import { generateImageTool } from "@/tools/magica-tools";
import type { AnyToolDefinition } from "@/tools/types";
import { settleToolInvocationCredits } from "./credit-settlement";
import {
  RECOVERY_SWEEP_INTERVAL_MS,
  SETTLEMENT_EPOCH,
  sweepBillableInvocations,
  sweepSettlementKey,
  type RecoveryDeps,
} from "./billable-recovery";

const mockGetRun = vi.mocked(getMagicaRun);
const createdUserIds: string[] = [];
afterAll(() => cleanupTestUsers(createdUserIds));
beforeEach(() => {
  mockGetRun.mockReset();
  vi.mocked(startMagicaRun).mockClear();
});
afterEach(() => expect(startMagicaRun).not.toHaveBeenCalled());

function deps(overrides: Partial<RecoveryDeps> = {}): RecoveryDeps & {
  dispatchSettlement: ReturnType<typeof vi.fn>;
  dispatchArchival: ReturnType<typeof vi.fn>;
} {
  return {
    registry: createToolRegistry([generateImageTool]),
    dispatchSettlement: vi.fn().mockResolvedValue(true),
    dispatchArchival: vi.fn().mockResolvedValue("dispatched"),
    ...overrides,
  } as never;
}

/** Only this test's rows are made old, so concurrent test files are never touched. */
async function age(table: "ToolInvocation" | "AgentRun", id: string, minutes: number) {
  if (table === "ToolInvocation") {
    await prisma.$executeRaw`UPDATE "ToolInvocation" SET "updatedAt" = now() - make_interval(mins => ${minutes}) WHERE "id" = ${id}::uuid`;
  } else {
    await prisma.$executeRaw`UPDATE "AgentRun" SET "updatedAt" = now() - make_interval(mins => ${minutes}) WHERE "id" = ${id}::uuid`;
  }
}

async function invocation(
  label: string,
  opts: { status: "RUNNING" | "COMPLETED" | "FAILED"; output?: object; creditsCharged?: bigint; createdAt?: Date; runStatus?: "RUNNING" | "FAILED" },
) {
  const user = await makeTestUser(label);
  createdUserIds.push(user.id);
  await prisma.creditAccount.create({ data: { userId: user.id, balance: BigInt(1_000_000) } });
  const chat = await prisma.chat.create({ data: { userId: user.id } });
  const run = await prisma.agentRun.create({
    data: { chatId: chat.id, userId: user.id, idempotencyKey: randomUUID(), status: opts.runStatus ?? "FAILED" },
  });
  const inv = await prisma.toolInvocation.create({
    data: {
      agentRunId: run.id,
      toolName: "generate_image",
      idempotencyKey: randomUUID(),
      input: { prompt: "x", size: "1024x1024" },
      status: opts.status,
      providerRunId: `mr_${randomUUID()}`,
      ...(opts.output ? { output: opts.output } : {}),
      ...(opts.creditsCharged !== undefined ? { creditsUsed: opts.creditsCharged, creditsCharged: opts.creditsCharged } : {}),
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    },
  });
  return { user, run, inv };
}

async function staleRunning(label: string) {
  const fixture = await invocation(label, { status: "RUNNING" });
  await age("ToolInvocation", fixture.inv.id, 20);
  await age("AgentRun", fixture.run.id, 20);
  return fixture;
}

const poll = (overrides: Record<string, unknown>) =>
  ({ id: "x", nodeType: "gpt_image_2", status: "RUNNING", createdAt: "2026-01-01T00:00:00Z", ...overrides }) as never;

const dispatchedIds = (d: ReturnType<typeof deps>) => d.dispatchSettlement.mock.calls.map((c) => c[0]);

describe("stale RUNNING billable invocations", () => {
  it("reconciles with one status read of the persisted run, persists COMPLETED with usage, then dispatches settlement and archival", async () => {
    const { inv } = await staleRunning("rec-completed");
    mockGetRun.mockResolvedValueOnce(poll({ status: "COMPLETED", output: { result: ["https://g.tlcdn.com/r.png"] }, creditUsed: 68_484 }));
    const d = deps();
    const now = new Date();

    await sweepBillableInvocations(d, now);

    expect(mockGetRun).toHaveBeenCalledTimes(1);
    expect(mockGetRun).toHaveBeenCalledWith(inv.providerRunId);
    const after = await prisma.toolInvocation.findUniqueOrThrow({ where: { id: inv.id } });
    expect(after.status).toBe("COMPLETED");
    expect(after.output).toMatchObject({ images: ["https://g.tlcdn.com/r.png"], creditUsed: 68_484 });
    expect(d.dispatchSettlement).toHaveBeenCalledWith(inv.id, sweepSettlementKey(inv.id, now));
    expect(d.dispatchArchival).toHaveBeenCalledWith(inv.id);
  });

  it("keeps the usage a failed/cancelled provider run reported", async () => {
    const { inv } = await staleRunning("rec-failed-usage");
    mockGetRun.mockResolvedValueOnce(poll({ status: "CANCELED", creditUsed: 5000 }));
    const d = deps();
    await sweepBillableInvocations(d);
    expect(await prisma.toolInvocation.findUniqueOrThrow({ where: { id: inv.id } })).toMatchObject({
      status: "FAILED",
      errorCode: "MAGICA_RUN_CANCELED",
      output: { creditUsed: 5000 },
    });
    expect(dispatchedIds(d)).toContain(inv.id);
    expect(d.dispatchArchival).not.toHaveBeenCalledWith(inv.id);
  });

  it("leaves an invocation whose provider run is still running untouched, without waiting", async () => {
    const { inv } = await staleRunning("rec-still-running");
    mockGetRun.mockResolvedValueOnce(poll({ status: "RUNNING" }));
    const d = deps();
    // generateImageTool's real durable wait would throw outside a task: passing proves no wait happened.
    await sweepBillableInvocations(d);
    expect((await prisma.toolInvocation.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe("RUNNING");
    expect(dispatchedIds(d)).not.toContain(inv.id);
  });

  it("handles a provider status-read failure safely (left RUNNING for the next sweep)", async () => {
    const { inv } = await staleRunning("rec-poll-error");
    mockGetRun.mockRejectedValueOnce(new MagicaAmbiguousError("Magica poll returned HTTP 503", "MAGICA_POLL_TRANSIENT"));
    const d = deps();
    await sweepBillableInvocations(d);
    expect((await prisma.toolInvocation.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe("RUNNING");
    expect(dispatchedIds(d)).not.toContain(inv.id);
  });

  it("logs and skips an unexpected reconcile error without changing the invocation", async () => {
    const { inv } = await staleRunning("rec-reconcile-throws");
    const broken: AnyToolDefinition = { ...generateImageTool, reconcile: () => Promise.reject(new Error("boom")) };
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const d = deps({ registry: createToolRegistry([broken]) });
    const summary = await sweepBillableInvocations(d);
    expect(summary.reconcileFailed).toBeGreaterThanOrEqual(1);
    expect(log).toHaveBeenCalledWith("Billable recovery: reconcile failed", expect.objectContaining({ toolInvocationId: inv.id }));
    expect((await prisma.toolInvocation.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe("RUNNING");
    log.mockRestore();
  });

  it("never interferes with an invocation that is not stale yet", async () => {
    const { inv } = await invocation("rec-active", { status: "RUNNING", runStatus: "RUNNING" });
    mockGetRun.mockResolvedValue(poll({ status: "COMPLETED", output: { result: ["https://g.tlcdn.com/a.png"] }, creditUsed: 1 }));
    await sweepBillableInvocations(deps());
    expect((await prisma.toolInvocation.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe("RUNNING");
  });

  it("transitions an invocation exactly once under concurrent sweeps", async () => {
    const { inv } = await staleRunning("rec-concurrent");
    mockGetRun.mockResolvedValue(poll({ status: "COMPLETED", output: { result: ["https://g.tlcdn.com/c.png"] }, creditUsed: 5000 }));
    const a = deps();
    const b = deps();
    await Promise.all([sweepBillableInvocations(a), sweepBillableInvocations(b)]);
    const dispatches = [...dispatchedIds(a), ...dispatchedIds(b)].filter((id) => id === inv.id);
    expect(dispatches).toHaveLength(1);
    expect((await prisma.toolInvocation.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe("COMPLETED");
  });
});

describe("terminal billable invocations awaiting settlement", () => {
  it("dispatches settlement for reported usage never settled (e.g. crash after outcome persistence)", async () => {
    const { inv } = await invocation("rec-terminal", { status: "COMPLETED", output: { images: ["https://x/a.png"], creditUsed: 273_936 } });
    await age("ToolInvocation", inv.id, 10);
    const d = deps();
    const now = new Date();
    await sweepBillableInvocations(d, now);
    expect(d.dispatchSettlement).toHaveBeenCalledWith(inv.id, sweepSettlementKey(inv.id, now));
  });

  it("recovers previously unsettled real usage exactly once across repeated sweeps", async () => {
    const { user, inv } = await invocation("rec-real-usage", { status: "FAILED", output: { creditUsed: 5000 } });
    await age("ToolInvocation", inv.id, 10);
    const settleNow = vi.fn((id: string) => settleToolInvocationCredits(id).then(() => true));
    const d = deps({ dispatchSettlement: settleNow });

    await sweepBillableInvocations(d);
    await sweepBillableInvocations(d);

    expect(settleNow.mock.calls.filter(([id]) => id === inv.id)).toHaveLength(1);
    expect(await prisma.creditLedger.count({ where: { toolInvocationId: inv.id } })).toBe(1);
    expect((await prisma.creditAccount.findUniqueOrThrow({ where: { userId: user.id } })).balance).toBe(BigInt(995_000));
  });

  it("does not dispatch an already-settled invocation", async () => {
    const { inv } = await invocation("rec-settled", { status: "COMPLETED", output: { creditUsed: 5000 }, creditsCharged: BigInt(5000) });
    await age("ToolInvocation", inv.id, 10);
    const d = deps();
    await sweepBillableInvocations(d);
    expect(dispatchedIds(d)).not.toContain(inv.id);
  });

  it("ignores terminal invocations without reported usage, inside the grace period, or before the credit epoch", async () => {
    const noUsage = await invocation("rec-no-usage", { status: "FAILED" });
    await age("ToolInvocation", noUsage.inv.id, 10);
    const fresh = await invocation("rec-fresh", { status: "COMPLETED", output: { creditUsed: 5000 } });
    const preEpoch = await invocation("rec-pre-epoch", {
      status: "COMPLETED",
      output: { creditUsed: 5000 },
      createdAt: new Date(SETTLEMENT_EPOCH.getTime() - 60_000),
    });
    await age("ToolInvocation", preEpoch.inv.id, 10);
    const d = deps();
    await sweepBillableInvocations(d);
    for (const { inv } of [noUsage, fresh, preEpoch]) expect(dispatchedIds(d)).not.toContain(inv.id);
  });

  it("counts a failed settlement dispatch and retries it in the next sweep window", async () => {
    const { inv } = await invocation("rec-dispatch-fail", { status: "COMPLETED", output: { creditUsed: 5000 } });
    await age("ToolInvocation", inv.id, 10);
    const failing = deps({ dispatchSettlement: vi.fn().mockResolvedValue(false) });
    const first = new Date();
    const summary = await sweepBillableInvocations(failing, first);
    expect(summary.settlementDispatchFailed).toBeGreaterThanOrEqual(1);

    const retry = deps();
    const next = new Date(first.getTime() + RECOVERY_SWEEP_INTERVAL_MS);
    await sweepBillableInvocations(retry, next);
    expect(retry.dispatchSettlement).toHaveBeenCalledWith(inv.id, sweepSettlementKey(inv.id, next));
    expect(sweepSettlementKey(inv.id, next)).not.toBe(sweepSettlementKey(inv.id, first));
  });
});
