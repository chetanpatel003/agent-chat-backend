import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { makeTestUser, cleanupTestUsers } from "@/test-utils/db-fixtures";
import { casAgentRunStatus } from "./run-transitions";

const createdUserIds: string[] = [];
afterAll(() => cleanupTestUsers(createdUserIds));

async function user(label: string) {
  const u = await makeTestUser(label);
  createdUserIds.push(u.id);
  return u;
}

async function run(ownerId: string, status: "QUEUED" | "RUNNING" | "CANCELLED" | "COMPLETED") {
  const owner = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });
  const chat = await prisma.chat.create({ data: { userId: owner.id } });
  return prisma.agentRun.create({
    data: { chatId: chat.id, userId: owner.id, idempotencyKey: randomUUID(), status },
  });
}

describe("casAgentRunStatus", () => {
  it("applies the write when the row's current status is in `from`", async () => {
    const owner = await user("cas-apply");
    const r = await run(owner.id, "QUEUED");

    const result = await casAgentRunStatus(r.id, ["QUEUED"], { status: "RUNNING" });
    expect(result).toEqual({ applied: true });

    const updated = await prisma.agentRun.findUniqueOrThrow({ where: { id: r.id } });
    expect(updated.status).toBe("RUNNING");
  });

  it("does not apply the write, and reports the real current status, when the row has already moved on", async () => {
    const owner = await user("cas-skip");
    const r = await run(owner.id, "CANCELLED");

    const result = await casAgentRunStatus(r.id, ["QUEUED", "RUNNING"], { status: "RUNNING" });
    expect(result).toEqual({ applied: false, currentStatus: "CANCELLED" });

    // Confirms the write genuinely never landed — not just that the
    // function *reported* skipped.
    const unchanged = await prisma.agentRun.findUniqueOrThrow({ where: { id: r.id } });
    expect(unchanged.status).toBe("CANCELLED");
  });
});
