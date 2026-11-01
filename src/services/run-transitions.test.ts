import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { makeTestUser, cleanupTestUsers } from "@/test-utils/db-fixtures";
import { casAgentRunStatus, isAgentRunRecentlyActive } from "./run-transitions";

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

describe("isAgentRunRecentlyActive", () => {
  it("is true for a row updated well within the threshold", async () => {
    const owner = await user("liveness-fresh");
    const r = await run(owner.id, "RUNNING");
    // The row's own creation already set updatedAt to "now".
    expect(await isAgentRunRecentlyActive(r.id, 60_000)).toBe(true);
  });

  it("is false once the row's last write is older than the threshold", async () => {
    const owner = await user("liveness-stale");
    const r = await run(owner.id, "RUNNING");
    await prisma.$executeRaw`UPDATE "AgentRun" SET "updatedAt" = ${new Date(Date.now() - 5 * 60_000)} WHERE "id" = ${r.id}::uuid`;

    expect(await isAgentRunRecentlyActive(r.id, 60_000)).toBe(false);
  });

  it("re-reads the row fresh each call rather than caching — a later write flips it back to true", async () => {
    const owner = await user("liveness-refresh");
    const r = await run(owner.id, "RUNNING");
    await prisma.$executeRaw`UPDATE "AgentRun" SET "updatedAt" = ${new Date(Date.now() - 5 * 60_000)} WHERE "id" = ${r.id}::uuid`;
    expect(await isAgentRunRecentlyActive(r.id, 60_000)).toBe(false);

    await prisma.agentRun.update({ where: { id: r.id }, data: { turnCount: 1 } });
    expect(await isAgentRunRecentlyActive(r.id, 60_000)).toBe(true);
  });
});
