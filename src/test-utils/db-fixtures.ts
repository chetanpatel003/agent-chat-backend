import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";

/** Real-database test helpers shared by the checkpoint 1.3 service tests
 * (chat/message/credits) — same pattern ownership.test.ts established in
 * checkpoint 1.2, factored out now that several files need it. */

export async function makeTestUser(label: string) {
  return prisma.user.create({
    data: {
      clerkUserId: `test_ckpt1.3_${label}_${randomUUID()}`,
      email: `${label}@example.com`,
    },
  });
}

/** Deletes everything created under the given user ids, in the order
 * ON DELETE RESTRICT requires (children before the User row itself).
 * ToolInvocation/Waitpoint included defensively even though no test uses
 * them yet (Phase 2 checkpoints after 2.1 will) — RESTRICT against
 * AgentRun, so they'd block cleanup the first time something does. */
export async function cleanupTestUsers(userIds: string[]) {
  if (!userIds.length) return;
  const where = { userId: { in: userIds } };
  await prisma.toolInvocation.deleteMany({
    where: { agentRun: { userId: { in: userIds } } },
  });
  await prisma.waitpoint.deleteMany({
    where: { agentRun: { userId: { in: userIds } } },
  });
  await prisma.runSkill.deleteMany({
    where: { agentRun: { userId: { in: userIds } } },
  });
  await prisma.agentRun.deleteMany({ where });
  await prisma.message.deleteMany({ where });
  await prisma.chat.deleteMany({ where });
  await prisma.creditLedger.deleteMany({ where });
  await prisma.creditAccount.deleteMany({ where });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}
