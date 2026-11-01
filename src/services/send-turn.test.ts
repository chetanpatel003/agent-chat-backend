// Precondition: `pnpm trigger:dev` must be running in a separate
// terminal. The "real worker completes it" test below dispatches a
// genuine task and waits for the actual Trigger.dev dev worker to run
// it — without that worker up, it times out after 20s rather than
// failing fast with a clear reason (a real gap; fine for now since
// every checkpoint 2.1+ test run already needs the worker for the
// same reason).
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { makeTestUser, cleanupTestUsers } from "@/test-utils/db-fixtures";
import { sendTurn } from "./send-turn";

const createdUserIds: string[] = [];
afterAll(() => cleanupTestUsers(createdUserIds));

async function user(label: string) {
  const u = await makeTestUser(label);
  createdUserIds.push(u.id);
  return u;
}

async function waitForTerminal(runId: string) {
  let run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });
  for (let i = 0; i < 15 && !["COMPLETED", "FAILED", "CANCELLED"].includes(run.status); i++) {
    await new Promise((r) => setTimeout(r, 1000));
    run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });
  }
  return run;
}

describe("sendTurn", () => {
  it(
    "creates a user message + AgentRun, dispatches it, and the real Trigger.dev dev worker completes it",
    async () => {
      const owner = await user("send-happy");
      const chat = await prisma.chat.create({ data: { userId: owner.id } });

      const result = await sendTurn(owner.id, chat.id, randomUUID(), { text: "hello" });

      expect(result.chatId).toBe(chat.id);
      expect(result.triggerRunId).toMatch(/^run_/);

      const run = await waitForTerminal(result.runId);
      expect(run.status).toBe("COMPLETED");

      const assistantMsg = await prisma.message.findFirst({
        where: { agentRunId: result.runId, role: "ASSISTANT" },
      });
      expect(assistantMsg).not.toBeNull();

      const updatedChat = await prisma.chat.findUniqueOrThrow({ where: { id: chat.id } });
      expect(updatedChat.lastMessageAt.getTime()).toBeGreaterThanOrEqual(
        assistantMsg!.createdAt.getTime(),
      );
    },
    20000,
  );

  it("is idempotent — the same Idempotency-Key returns the same dispatch, never a second run or message", async () => {
    const owner = await user("send-idempotent");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const key = randomUUID();

    const first = await sendTurn(owner.id, chat.id, key, { text: "once" });
    const second = await sendTurn(owner.id, chat.id, key, { text: "once (retried)" });

    expect(second).toEqual(first);
    expect(await prisma.agentRun.count({ where: { chatId: chat.id } })).toBe(1);
    expect(
      await prisma.message.count({ where: { chatId: chat.id, role: "USER" } }),
    ).toBe(1);
  });

  it("rejects a second send while a run is already active for the chat, creating no second run", async () => {
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

    await expect(
      sendTurn(owner.id, chat.id, randomUUID(), { text: "hi" }),
    ).rejects.toThrow(ConflictError);
    expect(await prisma.agentRun.count({ where: { chatId: chat.id } })).toBe(1);
  });

  it("rejects sending to a chat owned by someone else", async () => {
    const owner = await user("send-owner");
    const intruder = await user("send-intruder");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });

    await expect(
      sendTurn(intruder.id, chat.id, randomUUID(), { text: "hi" }),
    ).rejects.toThrow(NotFoundError);
  });
});
