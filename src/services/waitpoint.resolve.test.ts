import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { makeTestUser, cleanupTestUsers } from "@/test-utils/db-fixtures";
import { listMessages } from "./message";
import { resolveWaitpoint, type WaitpointTokenClient } from "./waitpoint";

// Resolving an approval checks the run's Trigger.dev execution first:
// finished → 409 and the run is interrupted at once (not left for the sweep);
// unknown/unreadable → retryable 503 with nothing changed.

const createdUserIds: string[] = [];
afterAll(() => cleanupTestUsers(createdUserIds));

async function waitingRun(label: string, waitpointStatus: "PENDING" | "RESOLVED" = "PENDING") {
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
      triggerRunId: `run_test_${randomUUID()}`,
    },
  });
  const message = await prisma.message.create({
    data: {
      chatId: chat.id,
      userId: owner.id,
      agentRunId: run.id,
      role: "ASSISTANT",
      status: "PENDING",
      content: [{ type: "text", text: "1. The plan" }],
    },
  });
  const waitpoint = await prisma.waitpoint.create({
    data: {
      agentRunId: run.id,
      type: "PLAN",
      token: `tok_${randomUUID()}`,
      idempotencyKey: randomUUID(),
      payload: { plan: "1. The plan" },
      status: waitpointStatus,
      expiresAt: new Date(Date.now() + 3600_000),
      ...(waitpointStatus === "RESOLVED" ? { resolution: { decision: "approve" }, resolvedAt: new Date() } : {}),
    },
  });
  return { owner, chat, run, message, waitpoint };
}

function tokenClient() {
  const completed: string[] = [];
  const client: WaitpointTokenClient = {
    status: async () => "WAITING",
    complete: async (id) => void completed.push(id),
  };
  return { client, completed };
}

async function state(runId: string, waitpointId: string, messageId: string) {
  const [run, waitpoint, message] = await Promise.all([
    prisma.agentRun.findUniqueOrThrow({ where: { id: runId } }),
    prisma.waitpoint.findUniqueOrThrow({ where: { id: waitpointId } }),
    prisma.message.findUniqueOrThrow({ where: { id: messageId } }),
  ]);
  return { run, waitpoint, message };
}

describe("resolveWaitpoint — Trigger.dev execution check", () => {
  it.each(["CANCELED", "COMPLETED", "FAILED", "CRASHED", "SYSTEM_FAILURE", "TIMED_OUT", "EXPIRED"])(
    "execution %s: 409, waitpoint CANCELLED, run FAILED RUN_INTERRUPTED, plan kept, token never completed",
    async (triggerStatus) => {
      const { owner, chat, run, message, waitpoint } = await waitingRun(`resolve-dead-${triggerStatus.toLowerCase()}`);
      const tokens = tokenClient();
      await expect(
        resolveWaitpoint(owner.id, chat.id, run.id, waitpoint.id, { decision: "reject" }, tokens.client, async () => triggerStatus),
      ).rejects.toMatchObject({ name: "RunInterruptedError" });

      const after = await state(run.id, waitpoint.id, message.id);
      expect(after.waitpoint.status).toBe("CANCELLED");
      expect(after.waitpoint.resolution).toBeNull(); // never reported as decided
      expect(after.run).toMatchObject({ status: "FAILED", errorCode: "RUN_INTERRUPTED", waitingReason: null });
      expect(after.message).toMatchObject({ status: "PENDING", content: [{ type: "text", text: "1. The plan" }] });
      expect(tokens.completed).toEqual([]);
    },
  );

  it("concurrent requests against a finished execution make exactly one transition", async () => {
    const { owner, chat, run, message, waitpoint } = await waitingRun("resolve-dead-concurrent");
    const tokens = tokenClient();
    const results = await Promise.allSettled(
      ["approve", "reject", "approve"].map((decision) =>
        resolveWaitpoint(owner.id, chat.id, run.id, waitpoint.id, { decision }, tokens.client, async () => "CANCELED"),
      ),
    );
    // Every request fails (409 for those that saw it pending, 409 "stopped" for later ones); none succeeds.
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    const after = await state(run.id, waitpoint.id, message.id);
    expect(after.run.status).toBe("FAILED");
    expect(after.waitpoint.status).toBe("CANCELLED");
    expect(tokens.completed).toEqual([]);
    // One transition: completedAt is written once and a later attempt changes nothing.
    await expect(
      resolveWaitpoint(owner.id, chat.id, run.id, waitpoint.id, { decision: "reject" }, tokens.client, async () => "CANCELED"),
    ).rejects.toMatchObject({ name: "ConflictError" });
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).completedAt).toEqual(after.run.completedAt);
  });

  it.each([
    ["unreadable", async () => Promise.reject(new Error("Trigger.dev unavailable"))],
    ["unrecognised", async () => "SOMETHING_NEW"],
  ])("execution status %s: retryable 503, nothing changed, approval still pending", async (_label, readStatus) => {
    const { owner, chat, run, message, waitpoint } = await waitingRun(`resolve-unknown-${_label}`);
    const tokens = tokenClient();
    await expect(
      resolveWaitpoint(owner.id, chat.id, run.id, waitpoint.id, { decision: "approve" }, tokens.client, readStatus),
    ).rejects.toMatchObject({ name: "ExecutionStatusUnavailableError" });
    const after = await state(run.id, waitpoint.id, message.id);
    expect(after.waitpoint.status).toBe("PENDING");
    expect(after.run).toMatchObject({ status: "WAITING", errorCode: null });
    expect(tokens.completed).toEqual([]);
  });

  it("a run without a recorded Trigger.dev run cannot be verified: retryable 503, nothing changed", async () => {
    const { owner, chat, run, message, waitpoint } = await waitingRun("resolve-no-trigger-run");
    await prisma.agentRun.update({ where: { id: run.id }, data: { triggerRunId: null } });
    const tokens = tokenClient();
    await expect(
      resolveWaitpoint(owner.id, chat.id, run.id, waitpoint.id, { decision: "approve" }, tokens.client, async () => "EXECUTING"),
    ).rejects.toMatchObject({ name: "ExecutionStatusUnavailableError" });
    expect((await state(run.id, waitpoint.id, message.id)).waitpoint.status).toBe("PENDING");
  });

  it.each(["EXECUTING", "WAITING"])("execution %s (live): the decision is applied and the token completed once", async (status) => {
    const { owner, chat, run, waitpoint } = await waitingRun(`resolve-live-${status.toLowerCase()}`);
    const tokens = tokenClient();
    const resolved = await resolveWaitpoint(owner.id, chat.id, run.id, waitpoint.id, { decision: "approve" }, tokens.client, async () => status);
    expect(resolved).toMatchObject({ status: "RESOLVED", resolution: { decision: "approve" } });
    expect(tokens.completed).toEqual([waitpoint.token]);
  });

  it("a repeat for an already-decided approval whose execution has since finished: 409 and the run is interrupted", async () => {
    const { owner, chat, run, message, waitpoint } = await waitingRun("resolve-resolved-dead", "RESOLVED");
    const tokens = tokenClient();
    await expect(
      resolveWaitpoint(owner.id, chat.id, run.id, waitpoint.id, { decision: "approve" }, tokens.client, async () => "CANCELED"),
    ).rejects.toMatchObject({ name: "RunInterruptedError" });
    const after = await state(run.id, waitpoint.id, message.id);
    expect(after.run).toMatchObject({ status: "FAILED", errorCode: "RUN_INTERRUPTED" });
    expect(after.waitpoint.status).toBe("RESOLVED"); // the recorded decision is history, not rewritten
    expect(tokens.completed).toEqual([]);
  });

  it("the interrupted turn's message is reported with its reason, so the UI never shows it as in progress", async () => {
    const { owner, chat, run, waitpoint } = await waitingRun("resolve-dead-message");
    await expect(
      resolveWaitpoint(owner.id, chat.id, run.id, waitpoint.id, { decision: "reject" }, tokenClient().client, async () => "CANCELED"),
    ).rejects.toThrow();
    const page = await listMessages(owner.id, chat.id, { limit: 10 });
    expect(page.items[0]).toMatchObject({
      status: "PENDING",
      content: [{ type: "text", text: "1. The plan" }],
      error: { code: "RUN_INTERRUPTED", message: "The execution stopped unexpectedly. Send a new message to continue." },
    });
  });
});
