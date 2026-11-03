import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/providers/openrouter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/providers/openrouter")>();
  return { ...actual, callOpenRouter: vi.fn() };
});

import { callOpenRouter } from "@/providers/openrouter";
import { prisma } from "@/lib/prisma";
import { makeTestUser, cleanupTestUsers } from "@/test-utils/db-fixtures";
import type { PublishRunEvent } from "@/realtime/publish-run-event";
import { executeAgentTurn } from "@/trigger/run-agent-turn";
import { createToolRegistry } from "@/tools/registry";
import { getBalance, listLedger } from "./credits";
import {
  outstandingShortfall,
  reportedCreditUsed,
  settleRunCredits,
  settleToolInvocationCredits,
  settlementIdempotencyKey,
} from "./credit-settlement";

const createdUserIds: string[] = [];
afterAll(() => cleanupTestUsers(createdUserIds));
beforeEach(() => {
  vi.mocked(callOpenRouter).mockReset(); // block body: a returned function would run as a teardown
});

async function setup(label: string, opts: { balance?: number | null; toolName?: string; status?: "COMPLETED" | "FAILED"; output?: unknown } = {}) {
  const user = await makeTestUser(label);
  createdUserIds.push(user.id);
  if (opts.balance !== null) {
    await prisma.creditAccount.create({ data: { userId: user.id, balance: BigInt(opts.balance ?? 1_000_000) } });
  }
  const chat = await prisma.chat.create({ data: { userId: user.id } });
  const run = await prisma.agentRun.create({ data: { chatId: chat.id, userId: user.id, idempotencyKey: randomUUID(), status: "RUNNING" } });
  const invocation = await prisma.toolInvocation.create({
    data: {
      agentRunId: run.id,
      toolName: opts.toolName ?? "generate_image",
      idempotencyKey: randomUUID(),
      input: {},
      status: opts.status ?? "COMPLETED",
      output: (opts.output === undefined ? { images: ["https://x/a.png"], creditUsed: 273_936 } : opts.output) as object,
    },
  });
  return { user, run, invocation };
}

const balanceOf = async (userId: string) => (await prisma.creditAccount.findUniqueOrThrow({ where: { userId } })).balance;
const ledgerOf = (toolInvocationId: string) => prisma.creditLedger.findMany({ where: { toolInvocationId } });

describe("settleToolInvocationCredits", () => {
  it("charges Magica's raw creditUsed exactly — no division, no multiplier — in one transaction", async () => {
    const { user, invocation } = await setup("settle-ok");
    expect(await settleToolInvocationCredits(invocation.id)).toEqual({
      status: "settled",
      creditUsed: BigInt(273_936),
      charged: BigInt(273_936),
      shortfall: BigInt(0),
    });
    expect(await balanceOf(user.id)).toBe(BigInt(726_064));
    const [entry] = await ledgerOf(invocation.id);
    expect(entry).toMatchObject({
      userId: user.id,
      amount: BigInt(-273_936),
      type: "TOOL_CHARGE",
      idempotencyKey: settlementIdempotencyKey(invocation.id),
      balanceAfter: BigInt(726_064),
    });
    expect(await prisma.toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } })).toMatchObject({
      creditsUsed: BigInt(273_936),
      creditsCharged: BigInt(273_936),
    });
  });

  it("charges a FAILED run that reported nonzero usage", async () => {
    const { user, invocation } = await setup("settle-failed", { status: "FAILED", output: { creditUsed: 5000 } });
    expect(await settleToolInvocationCredits(invocation.id)).toMatchObject({ status: "settled", charged: BigInt(5000) });
    expect(await balanceOf(user.id)).toBe(BigInt(995_000));
    expect((await ledgerOf(invocation.id))[0].description).toContain("(failed)");
  });

  it("records zero usage as settled with no ledger entry and no balance change", async () => {
    const { user, invocation } = await setup("settle-zero", { status: "FAILED", output: { creditUsed: 0 } });
    expect(await settleToolInvocationCredits(invocation.id)).toMatchObject({ status: "settled", charged: BigInt(0) });
    expect(await ledgerOf(invocation.id)).toHaveLength(0);
    expect(await balanceOf(user.id)).toBe(BigInt(1_000_000));
    expect((await prisma.toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } })).creditsCharged).toBe(BigInt(0));
  });

  it("never charges the same invocation twice (sequential retry)", async () => {
    const { user, invocation } = await setup("settle-dup");
    await settleToolInvocationCredits(invocation.id);
    expect(await settleToolInvocationCredits(invocation.id)).toEqual({ status: "already_settled" });
    expect(await ledgerOf(invocation.id)).toHaveLength(1);
    expect(await balanceOf(user.id)).toBe(BigInt(726_064));
  });

  it("charges exactly once under concurrent settlement attempts", async () => {
    const { user, invocation } = await setup("settle-race");
    const results = await Promise.all([1, 2, 3].map(() => settleToolInvocationCredits(invocation.id)));
    expect(results.filter((r) => r.status === "settled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "already_settled")).toHaveLength(2);
    expect(await ledgerOf(invocation.id)).toHaveLength(1);
    expect(await balanceOf(user.id)).toBe(BigInt(726_064));
  });

  it("serializes concurrent settlements of different invocations for the same user", async () => {
    const { user, run } = await setup("settle-two");
    const second = await prisma.toolInvocation.create({
      data: { agentRunId: run.id, toolName: "crop_image", idempotencyKey: randomUUID(), input: {}, status: "COMPLETED", output: { creditUsed: 5000 } },
    });
    const first = await prisma.toolInvocation.findFirstOrThrow({ where: { agentRunId: run.id, toolName: "generate_image" } });
    await Promise.all([settleToolInvocationCredits(first.id), settleToolInvocationCredits(second.id)]);
    expect(await balanceOf(user.id)).toBe(BigInt(1_000_000 - 273_936 - 5000));
    // Either order is valid, but each entry's balanceAfter must reflect the other's debit (no lost update).
    const after = (await prisma.creditLedger.findMany({ where: { userId: user.id } }))
      .map((e) => e.balanceAfter)
      .sort((a, b) => (a < b ? 1 : -1));
    expect([[BigInt(726_064), BigInt(721_064)], [BigInt(995_000), BigInt(721_064)]]).toContainEqual(after);
  });

  it("rolls back the debit and the invocation claim if the ledger write fails (unique key held)", async () => {
    const { user, invocation } = await setup("settle-rollback");
    await prisma.creditLedger.create({
      data: {
        userId: user.id,
        amount: BigInt(0),
        type: "ADJUSTMENT",
        idempotencyKey: settlementIdempotencyKey(invocation.id),
        balanceAfter: BigInt(1_000_000),
        description: "conflicting row for rollback test",
      },
    });
    await expect(settleToolInvocationCredits(invocation.id)).rejects.toThrow();
    expect(await balanceOf(user.id)).toBe(BigInt(1_000_000));
    expect((await prisma.toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } })).creditsCharged).toBeNull();
  });

  it("never drives the balance negative: debits what is available and records the shortfall", async () => {
    const { user, invocation } = await setup("settle-short", { balance: 1000, output: { creditUsed: 5000 } });
    expect(await settleToolInvocationCredits(invocation.id)).toEqual({
      status: "settled",
      creditUsed: BigInt(5000),
      charged: BigInt(1000),
      shortfall: BigInt(4000),
    });
    expect(await balanceOf(user.id)).toBe(BigInt(0));
    const [entry] = await ledgerOf(invocation.id);
    expect(entry.amount).toBe(BigInt(-1000));
    expect(entry.description).toContain("4000 not recovered");
    // Actual usage is never lost; the shortfall is machine-readable.
    expect(await prisma.toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } })).toMatchObject({
      creditsUsed: BigInt(5000),
      creditsCharged: BigInt(1000),
    });
    expect(await outstandingShortfall(user.id)).toBe(BigInt(4000));
  });

  it("reports zero outstanding shortfall when usage was fully collected", async () => {
    const { user, invocation } = await setup("settle-no-shortfall");
    await settleToolInvocationCredits(invocation.id);
    expect(await outstandingShortfall(user.id)).toBe(BigInt(0));
  });

  it("handles a user with no credit account: zero-balance account, nothing debited, shortfall recorded", async () => {
    const { user, invocation } = await setup("settle-no-account", { balance: null, output: { creditUsed: 5000 } });
    expect(await settleToolInvocationCredits(invocation.id)).toMatchObject({ charged: BigInt(0), shortfall: BigInt(5000) });
    expect(await balanceOf(user.id)).toBe(BigInt(0));
    expect((await ledgerOf(invocation.id))[0].amount).toBe(BigInt(0));
  });

  it("does not settle without reported usage, for non-billable tools, or for non-terminal invocations", async () => {
    const noUsage = await setup("settle-no-usage", { status: "FAILED", output: null });
    const skill = await setup("settle-skill", { toolName: "load_skill" });
    const running = await setup("settle-running");
    await prisma.toolInvocation.update({ where: { id: running.invocation.id }, data: { status: "RUNNING" } });
    expect(await settleToolInvocationCredits(noUsage.invocation.id)).toEqual({ status: "no_usage_reported" });
    expect(await settleToolInvocationCredits(skill.invocation.id)).toEqual({ status: "not_billable" });
    expect(await settleToolInvocationCredits(running.invocation.id)).toEqual({ status: "not_billable" });
    expect(await prisma.creditLedger.count({ where: { userId: { in: [noUsage.user.id, skill.user.id, running.user.id] } } })).toBe(0);
  });

  it("recovery settles unsettled terminal billable invocations of a run, once", async () => {
    const { user, run, invocation } = await setup("settle-recovery");
    await settleRunCredits(run.id);
    await settleRunCredits(run.id);
    expect(await ledgerOf(invocation.id)).toHaveLength(1);
    expect(await balanceOf(user.id)).toBe(BigInt(726_064));
  });
});

describe("database CHECK constraints", () => {
  it("rejects any write that would make a credit balance negative", async () => {
    const { user } = await setup("check-balance", { balance: 10 });
    await expect(prisma.creditAccount.update({ where: { userId: user.id }, data: { balance: BigInt(-1) } })).rejects.toThrow();
    await expect(
      prisma.$executeRaw`UPDATE "CreditAccount" SET "balance" = "balance" - 11 WHERE "userId" = ${user.id}::uuid`,
    ).rejects.toThrow(/CreditAccount_balance_nonnegative/);
    expect(await balanceOf(user.id)).toBe(BigInt(10));
  });

  it("rejects a settled invocation that collects more than it used, or records no usage", async () => {
    const { invocation } = await setup("check-collected");
    await expect(
      prisma.toolInvocation.update({ where: { id: invocation.id }, data: { creditsUsed: BigInt(5), creditsCharged: BigInt(6) } }),
    ).rejects.toThrow();
    await expect(
      prisma.toolInvocation.update({ where: { id: invocation.id }, data: { creditsCharged: BigInt(1) } }),
    ).rejects.toThrow();
    expect((await prisma.toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } })).creditsCharged).toBeNull();
  });
});

describe("reportedCreditUsed", () => {
  it.each([
    [{ creditUsed: 8385 }, BigInt(8385)],
    [{ creditUsed: 0 }, BigInt(0)],
    [{ creditUsed: -1 }, null],
    [{ creditUsed: 1.5 }, null],
    [{ creditUsed: "8385" }, null],
    [{}, null],
    [null, null],
  ])("reads %j as %s", (output, expected) => {
    expect(reportedCreditUsed(output)).toBe(expected);
  });
});

describe("OpenRouter turns", () => {
  it("cost zero application credits: a text-only turn creates no ledger entries and leaves the balance unchanged", async () => {
    const user = await makeTestUser("settle-openrouter");
    createdUserIds.push(user.id);
    await prisma.creditAccount.create({ data: { userId: user.id, balance: BigInt(1_000_000) } });
    const chat = await prisma.chat.create({ data: { userId: user.id } });
    const run = await prisma.agentRun.create({ data: { chatId: chat.id, userId: user.id, idempotencyKey: randomUUID(), status: "QUEUED" } });
    await prisma.message.create({
      data: { chatId: chat.id, userId: user.id, agentRunId: run.id, role: "USER", status: "COMPLETE", content: [{ type: "text", text: "hi" }] },
    });
    vi.mocked(callOpenRouter).mockResolvedValueOnce({
      model: "x/y:free",
      text: "hello",
      toolCalls: null,
      promptTokens: 1200,
      completionTokens: 300,
    });
    const noopPublish: PublishRunEvent = vi.fn().mockResolvedValue(undefined);

    const result = await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([]), noopPublish);

    expect(result.status).toBe("COMPLETED");
    expect(await getBalance(user.id)).toEqual({ balance: 1_000_000 });
    expect((await listLedger(user.id, { limit: 10 })).items).toHaveLength(0);
  }, 40_000);
});
