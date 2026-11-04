// Edge-case audit (2026-11-04): a failed dispatch can be ambiguous — the
// trigger may have reached Trigger.dev (response lost, or the triggerRunId
// write failed) and the worker may already own the run, or the user may
// have stopped it. The fail-closed write used to be unguarded and could
// overwrite RUNNING/CANCELLED with FAILED. Real (isolated) database;
// Trigger.dev fully mocked — nothing is dispatched or cancelled for real.
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/trigger/run-agent-turn", () => ({ runAgentTurn: { trigger: vi.fn() } }));
vi.mock("@/trigger/generate-chat-title", () => ({ dispatchChatTitle: vi.fn().mockResolvedValue(true) }));
vi.mock("@trigger.dev/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@trigger.dev/sdk")>();
  return { ...actual, runs: { ...actual.runs, cancel: vi.fn().mockResolvedValue(undefined) } };
});

import { runs } from "@trigger.dev/sdk";
import { runAgentTurn } from "@/trigger/run-agent-turn";
import { prisma } from "@/lib/prisma";
import { makeTestUser, cleanupTestUsers } from "@/test-utils/db-fixtures";
import { sendTurn } from "./send-turn";

const mockTrigger = vi.mocked(runAgentTurn.trigger);
const mockCancel = vi.mocked(runs.cancel);
const createdUserIds: string[] = [];
beforeEach(() => {
  mockTrigger.mockReset();
  mockCancel.mockClear();
});
afterAll(() => cleanupTestUsers(createdUserIds));

async function chatFor(label: string) {
  const owner = await makeTestUser(label);
  createdUserIds.push(owner.id);
  const chat = await prisma.chat.create({ data: { userId: owner.id } });
  return { owner, chat };
}

type TriggerPayload = { agentRunId: string };
const runOf = (chatId: string) => prisma.agentRun.findFirstOrThrow({ where: { chatId } });

describe("sendTurn — dispatch failure never overwrites a run someone else already owns", () => {
  it("a plain dispatch failure (nothing reached Trigger.dev) still fails closed: FAILED / DISPATCH_FAILED", async () => {
    const { owner, chat } = await chatFor("dispatch-plain");
    mockTrigger.mockRejectedValueOnce(new Error("network down"));

    await expect(sendTurn(owner.id, chat.id, randomUUID(), { text: "hi" })).rejects.toThrow("network down");

    expect(await runOf(chat.id)).toMatchObject({ status: "FAILED", errorCode: "DISPATCH_FAILED" });
    expect(mockCancel).not.toHaveBeenCalled(); // no Trigger.dev run id was ever known
  });

  it("the worker already started the run (response lost): it stays RUNNING and is never cancelled", async () => {
    const { owner, chat } = await chatFor("dispatch-worker-owns");
    mockTrigger.mockImplementationOnce((async (payload: TriggerPayload) => {
      await prisma.agentRun.update({ where: { id: payload.agentRunId }, data: { status: "RUNNING", startedAt: new Date() } });
      throw new Error("response lost");
    }) as never);

    await expect(sendTurn(owner.id, chat.id, randomUUID(), { text: "hi" })).rejects.toThrow("response lost");

    const run = await runOf(chat.id);
    expect(run.status).toBe("RUNNING");
    expect(run.errorCode).toBeNull();
    expect(mockCancel).not.toHaveBeenCalled();
  });

  it("the user stopped the run meanwhile: CANCELLED is kept, not replaced by FAILED", async () => {
    const { owner, chat } = await chatFor("dispatch-cancelled");
    mockTrigger.mockImplementationOnce((async (payload: TriggerPayload) => {
      await prisma.agentRun.update({
        where: { id: payload.agentRunId },
        data: { status: "CANCELLED", errorCode: "CANCELLED_BY_USER", completedAt: new Date() },
      });
      throw new Error("timeout");
    }) as never);

    await expect(sendTurn(owner.id, chat.id, randomUUID(), { text: "hi" })).rejects.toThrow("timeout");

    expect(await runOf(chat.id)).toMatchObject({ status: "CANCELLED", errorCode: "CANCELLED_BY_USER" });
  });

  it("dispatched, but recording the Trigger.dev run id failed: the still-QUEUED run fails closed and that run is cancelled", async () => {
    const { owner, chat } = await chatFor("dispatch-record-failed");
    // A triggerRunId already taken by another run makes the record write fail (unique constraint).
    const taken = `run_taken_${randomUUID()}`;
    const other = await chatFor("dispatch-record-failed-other");
    await prisma.agentRun.create({
      data: { chatId: other.chat.id, userId: other.owner.id, idempotencyKey: randomUUID(), status: "COMPLETED", triggerRunId: taken },
    });
    mockTrigger.mockResolvedValueOnce({ id: taken } as never);

    await expect(sendTurn(owner.id, chat.id, randomUUID(), { text: "hi" })).rejects.toThrow();

    expect(await runOf(chat.id)).toMatchObject({ status: "FAILED", errorCode: "DISPATCH_FAILED", triggerRunId: null });
    expect(mockCancel).toHaveBeenCalledWith(taken);
  });
});
