import { describe, it, expect, afterAll, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

// cancelRun's best-effort Trigger.dev call — mocked everywhere in this
// file (never a real call) since most of these AgentRun rows are
// created directly, never actually dispatched, and the one test that
// does care about this call asserts against the mock directly.
vi.mock("@trigger.dev/sdk", () => ({ runs: { cancel: vi.fn() } }));

import { runs } from "@trigger.dev/sdk";
import { prisma } from "@/lib/prisma";
import { NotFoundError } from "@/lib/errors";
import { makeTestUser, cleanupTestUsers } from "@/test-utils/db-fixtures";
import { getActiveRun, cancelRun } from "./agent-run";

const mockCancel = vi.mocked(runs.cancel);

const createdUserIds: string[] = [];
afterAll(() => cleanupTestUsers(createdUserIds));

async function user(label: string) {
  const u = await makeTestUser(label);
  createdUserIds.push(u.id);
  return u;
}

describe("getActiveRun", () => {
  it("returns null when no run is active for the chat", async () => {
    const owner = await user("active-none");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    expect(await getActiveRun(owner.id, chat.id)).toBeNull();
  });

  it("returns the active run when one exists", async () => {
    const owner = await user("active-some");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const run = await prisma.agentRun.create({
      data: { chatId: chat.id, userId: owner.id, idempotencyKey: randomUUID(), status: "RUNNING" },
    });

    const result = await getActiveRun(owner.id, chat.id);
    expect(result?.id).toBe(run.id);
    expect(result?.status).toBe("RUNNING");
  });

  it("does not return a terminal run as active", async () => {
    const owner = await user("active-terminal");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    await prisma.agentRun.create({
      data: {
        chatId: chat.id,
        userId: owner.id,
        idempotencyKey: randomUUID(),
        status: "COMPLETED",
      },
    });
    expect(await getActiveRun(owner.id, chat.id)).toBeNull();
  });

  it("rejects a different user", async () => {
    const owner = await user("active-owner");
    const intruder = await user("active-intruder");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    await expect(getActiveRun(intruder.id, chat.id)).rejects.toThrow(NotFoundError);
  });
});

describe("cancelRun", () => {
  beforeEach(() => {
    mockCancel.mockReset();
    mockCancel.mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double, only resolution matters
      {} as any,
    );
  });

  it("cancels a QUEUED run — no triggerRunId yet, so runs.cancel is never called", async () => {
    const owner = await user("cancel-queued");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const run = await prisma.agentRun.create({
      data: { chatId: chat.id, userId: owner.id, idempotencyKey: randomUUID(), status: "QUEUED" },
    });

    const result = await cancelRun(owner.id, chat.id, run.id);
    expect(result.status).toBe("CANCELLED");
    expect(result.errorCode).toBe("CANCELLED_BY_USER");
    expect(mockCancel).not.toHaveBeenCalled();
  });

  it("cancels a RUNNING run and its PENDING assistant message, preserving already-persisted content", async () => {
    const owner = await user("cancel-running");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const run = await prisma.agentRun.create({
      data: {
        chatId: chat.id,
        userId: owner.id,
        idempotencyKey: randomUUID(),
        status: "RUNNING",
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
        content: [{ type: "text", text: "partial so far" }],
      },
    });

    const result = await cancelRun(owner.id, chat.id, run.id);
    expect(result.status).toBe("CANCELLED");
    expect(mockCancel).toHaveBeenCalledWith(run.triggerRunId);

    const updatedMessage = await prisma.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(updatedMessage.status).toBe("CANCELLED");
    expect(updatedMessage.content).toEqual([{ type: "text", text: "partial so far" }]);
  });

  it("is idempotent — cancelling an already-cancelled run returns its current state without a second runs.cancel call", async () => {
    const owner = await user("cancel-idempotent");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const run = await prisma.agentRun.create({
      data: {
        chatId: chat.id,
        userId: owner.id,
        idempotencyKey: randomUUID(),
        status: "RUNNING",
        triggerRunId: `run_${randomUUID()}`,
      },
    });

    const first = await cancelRun(owner.id, chat.id, run.id);
    const second = await cancelRun(owner.id, chat.id, run.id);
    expect(first.status).toBe("CANCELLED");
    expect(second.status).toBe("CANCELLED");
    expect(mockCancel).toHaveBeenCalledTimes(1);
  });

  it("returns an already-COMPLETED run unchanged — no write, no runs.cancel call", async () => {
    const owner = await user("cancel-already-terminal");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const run = await prisma.agentRun.create({
      data: {
        chatId: chat.id,
        userId: owner.id,
        idempotencyKey: randomUUID(),
        status: "COMPLETED",
        triggerRunId: `run_${randomUUID()}`,
        completedAt: new Date(),
      },
    });

    const result = await cancelRun(owner.id, chat.id, run.id);
    expect(result.status).toBe("COMPLETED");
    expect(mockCancel).not.toHaveBeenCalled();
  });

  it("rejects a different user with a non-leaking 404", async () => {
    const owner = await user("cancel-owner");
    const intruder = await user("cancel-intruder");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const run = await prisma.agentRun.create({
      data: { chatId: chat.id, userId: owner.id, idempotencyKey: randomUUID(), status: "QUEUED" },
    });
    await expect(cancelRun(intruder.id, chat.id, run.id)).rejects.toThrow(NotFoundError);
  });

  it("rejects a run that belongs to a different chat than the one named in the URL", async () => {
    const owner = await user("cancel-wrong-chat");
    const chatA = await prisma.chat.create({ data: { userId: owner.id } });
    const chatB = await prisma.chat.create({ data: { userId: owner.id } });
    const run = await prisma.agentRun.create({
      data: { chatId: chatA.id, userId: owner.id, idempotencyKey: randomUUID(), status: "QUEUED" },
    });
    await expect(cancelRun(owner.id, chatB.id, run.id)).rejects.toThrow(NotFoundError);
  });

  it("a Trigger.dev cancellation failure doesn't fail the request — Postgres stays authoritative", async () => {
    mockCancel.mockRejectedValueOnce(new Error("Trigger.dev API unreachable"));
    const owner = await user("cancel-trigger-fails");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const run = await prisma.agentRun.create({
      data: {
        chatId: chat.id,
        userId: owner.id,
        idempotencyKey: randomUUID(),
        status: "QUEUED",
        triggerRunId: `run_${randomUUID()}`,
      },
    });

    const result = await cancelRun(owner.id, chat.id, run.id);
    expect(result.status).toBe("CANCELLED");
  });
});
