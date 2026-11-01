// Precondition: `pnpm trigger:dev` must be running in a separate
// terminal. This file deliberately dispatches a genuine task and waits
// for the actual Trigger.dev dev worker to run it — it's the one place
// in the suite a real OpenRouter call is exercised end to end, per the
// checkpoint's "one controlled live connectivity test" allowance.
// Everything that doesn't need a real dispatch (idempotency, conflict,
// ownership) lives in send-turn.transactional.test.ts instead, mocked —
// see that file's header for why splitting this out mattered in practice.
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
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

describe("sendTurn — real end-to-end dispatch", () => {
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
});
