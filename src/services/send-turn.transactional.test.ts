// sendTurn()'s own transactional/idempotency-key/ownership behavior,
// independent of whether the dispatched task ever actually runs —
// `runAgentTurn.trigger` is mocked at the module level. A `vi.spyOn` on
// the Trigger.dev task object was tried first and didn't actually
// intercept the call site inside send-turn.ts (confirmed empirically —
// the call still took 5+ real seconds and the spy's own call count
// stayed at 0), so this is a full module mock instead, split into its
// own file so send-turn.test.ts can stay genuinely real without this
// file's tests paying for a dispatch they don't need.
import { describe, it, expect, vi, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/trigger/run-agent-turn", () => ({
  // A fresh id per call, not one fixed value for the whole file —
  // AgentRun.triggerRunId is unique; only one test here dispatches
  // successfully today, but a fixed value is a landmine for the next
  // test added that does too (checkpoint 2.4 hit exactly this in
  // send.test.ts).
  runAgentTurn: { trigger: vi.fn(() => Promise.resolve({ id: `run_mocked_${randomUUID()}` })) },
}));

import { runAgentTurn } from "@/trigger/run-agent-turn";
import { prisma } from "@/lib/prisma";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { makeTestUser, cleanupTestUsers } from "@/test-utils/db-fixtures";
import { sendTurn } from "./send-turn";

const mockTrigger = vi.mocked(runAgentTurn.trigger);
const createdUserIds: string[] = [];
afterAll(() => cleanupTestUsers(createdUserIds));

async function user(label: string) {
  const u = await makeTestUser(label);
  createdUserIds.push(u.id);
  return u;
}

describe("sendTurn — transactional behavior (dispatch mocked)", () => {
  it("is idempotent — the same Idempotency-Key returns the same dispatch, never a second run, message, or trigger call", async () => {
    const owner = await user("send-idempotent");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const key = randomUUID();

    const first = await sendTurn(owner.id, chat.id, key, { text: "once" });
    const second = await sendTurn(owner.id, chat.id, key, { text: "once (retried)" });

    expect(mockTrigger).toHaveBeenCalledTimes(1); // the retry never dispatches again
    expect(second).toEqual(first);
    expect(await prisma.agentRun.count({ where: { chatId: chat.id } })).toBe(1);
    expect(
      await prisma.message.count({ where: { chatId: chat.id, role: "USER" } }),
    ).toBe(1);
  });

  it("rejects a second send while a run is already active for the chat, creating no second run or trigger call", async () => {
    const owner = await user("send-conflict");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    await prisma.agentRun.create({
      data: {
        chatId: chat.id,
        userId: owner.id,
        idempotencyKey: randomUUID(),
        status: "RUNNING",
      },
    });

    mockTrigger.mockClear();
    await expect(
      sendTurn(owner.id, chat.id, randomUUID(), { text: "hi" }),
    ).rejects.toThrow(ConflictError);
    expect(await prisma.agentRun.count({ where: { chatId: chat.id } })).toBe(1);
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("rejects sending to a chat owned by someone else, without dispatching", async () => {
    const owner = await user("send-owner");
    const intruder = await user("send-intruder");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });

    mockTrigger.mockClear();
    await expect(
      sendTurn(intruder.id, chat.id, randomUUID(), { text: "hi" }),
    ).rejects.toThrow(NotFoundError);
    expect(mockTrigger).not.toHaveBeenCalled();
  });
});
