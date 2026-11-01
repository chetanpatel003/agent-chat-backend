import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { NotFoundError } from "@/lib/errors";
import { makeTestUser, cleanupTestUsers } from "@/test-utils/db-fixtures";
import { getActiveRun } from "./agent-run";

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
