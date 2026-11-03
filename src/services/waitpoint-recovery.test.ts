import { describe, it, expect, vi, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { makeTestUser, cleanupTestUsers } from "@/test-utils/db-fixtures";
import { sweepWaitpoints, RESOLVED_DELIVERY_GRACE_MS, WAITPOINT_EXPIRY_GRACE_MS } from "./waitpoint-recovery";
import type { WaitpointTokenClient } from "./waitpoint";

const createdUserIds: string[] = [];
afterAll(() => cleanupTestUsers(createdUserIds));

async function waitingRun(label: string, wp: { status: "PENDING" | "RESOLVED"; expiresAt: Date; resolvedAt?: Date }) {
  const owner = await makeTestUser(label);
  createdUserIds.push(owner.id);
  const chat = await prisma.chat.create({ data: { userId: owner.id } });
  const run = await prisma.agentRun.create({
    data: {
      chatId: chat.id,
      userId: owner.id,
      idempotencyKey: randomUUID(),
      status: "WAITING",
      waitingReason: "PLAN",
      planMode: true,
      triggerRunId: `run_${randomUUID()}`,
    },
  });
  const message = await prisma.message.create({
    data: {
      chatId: chat.id,
      userId: owner.id,
      agentRunId: run.id,
      role: "ASSISTANT",
      status: "PENDING",
      content: [{ type: "text", text: "1. Plan" }],
    },
  });
  const waitpoint = await prisma.waitpoint.create({
    data: {
      agentRunId: run.id,
      type: "PLAN",
      token: `tok_${randomUUID()}`,
      idempotencyKey: randomUUID(),
      payload: { plan: "1. Plan" },
      status: wp.status,
      expiresAt: wp.expiresAt,
      resolvedAt: wp.resolvedAt ?? null,
      resolution: wp.status === "RESOLVED" ? { decision: "approve" } : undefined,
    },
  });
  return { run, message, waitpoint };
}

function client(statuses: Record<string, "WAITING" | "COMPLETED" | "TIMED_OUT">, failComplete = false) {
  const completed: string[] = [];
  const c: WaitpointTokenClient = {
    status: async (id) => statuses[id] ?? "WAITING",
    complete: async (id) => {
      if (failComplete) throw new Error("unavailable");
      statuses[id] = "COMPLETED";
      completed.push(id);
    },
  };
  return { client: c, completed };
}

describe("sweepWaitpoints", () => {
  const now = new Date();

  it("expires an overdue PENDING waitpoint, stops its run (content kept) and cancels the suspended task", async () => {
    const { run, message, waitpoint } = await waitingRun("wp-sweep-expire", {
      status: "PENDING",
      expiresAt: new Date(now.getTime() - WAITPOINT_EXPIRY_GRACE_MS - 1000),
    });
    const cancelTriggerRun = vi.fn().mockResolvedValue(undefined);
    const summary = await sweepWaitpoints({ client: client({}).client, cancelTriggerRun }, now);
    expect(summary.expired).toBeGreaterThanOrEqual(1);

    const [wp, r, m] = await Promise.all([
      prisma.waitpoint.findUniqueOrThrow({ where: { id: waitpoint.id } }),
      prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } }),
      prisma.message.findUniqueOrThrow({ where: { id: message.id } }),
    ]);
    expect(wp.status).toBe("EXPIRED");
    expect(r).toMatchObject({ status: "CANCELLED", errorCode: "WAITPOINT_EXPIRED", waitingReason: null });
    expect(m.status).toBe("CANCELLED");
    expect(m.content).toEqual([{ type: "text", text: "1. Plan" }]);
    expect(cancelTriggerRun).toHaveBeenCalledWith(run.triggerRunId, expect.objectContaining({ waitpointId: waitpoint.id }));

    // Idempotent: a second sweep changes nothing for it.
    cancelTriggerRun.mockClear();
    await sweepWaitpoints({ client: client({}).client, cancelTriggerRun }, now);
    expect(cancelTriggerRun).not.toHaveBeenCalledWith(run.triggerRunId, expect.anything());
  });

  it("leaves a PENDING waitpoint inside its grace period alone", async () => {
    const { waitpoint } = await waitingRun("wp-sweep-grace", { status: "PENDING", expiresAt: new Date(now.getTime() - 1000) });
    await sweepWaitpoints({ client: client({}).client, cancelTriggerRun: vi.fn() }, now);
    expect((await prisma.waitpoint.findUniqueOrThrow({ where: { id: waitpoint.id } })).status).toBe("PENDING");
  });

  it("redelivers a saved decision whose token was never completed — the same token, once", async () => {
    const { waitpoint } = await waitingRun("wp-sweep-redeliver", {
      status: "RESOLVED",
      expiresAt: new Date(now.getTime() + 3600_000),
      resolvedAt: new Date(now.getTime() - RESOLVED_DELIVERY_GRACE_MS - 1000),
    });
    const statuses: Record<string, "WAITING" | "COMPLETED" | "TIMED_OUT"> = { [waitpoint.token]: "WAITING" };
    const { client: c, completed } = client(statuses);
    await sweepWaitpoints({ client: c, cancelTriggerRun: vi.fn() }, now);
    expect(completed.filter((t) => t === waitpoint.token)).toHaveLength(1);

    await sweepWaitpoints({ client: c, cancelTriggerRun: vi.fn() }, now);
    expect(completed.filter((t) => t === waitpoint.token)).toHaveLength(1); // already COMPLETED: not again
  });

  it("a failed redelivery is counted and left for the next sweep", async () => {
    const { waitpoint } = await waitingRun("wp-sweep-redeliver-fail", {
      status: "RESOLVED",
      expiresAt: new Date(now.getTime() + 3600_000),
      resolvedAt: new Date(now.getTime() - RESOLVED_DELIVERY_GRACE_MS - 1000),
    });
    const { client: c } = client({ [waitpoint.token]: "WAITING" }, true);
    const summary = await sweepWaitpoints({ client: c, cancelTriggerRun: vi.fn() }, now);
    expect(summary.redeliveryFailed).toBeGreaterThanOrEqual(1);
    expect((await prisma.waitpoint.findUniqueOrThrow({ where: { id: waitpoint.id } })).status).toBe("RESOLVED");
  });
});
