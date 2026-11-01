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
 * ON DELETE RESTRICT requires (children before the User row itself). */
export async function cleanupTestUsers(userIds: string[]) {
  if (!userIds.length) return;
  const where = { userId: { in: userIds } };
  await prisma.message.deleteMany({ where });
  await prisma.chat.deleteMany({ where });
  await prisma.creditLedger.deleteMany({ where });
  await prisma.creditAccount.deleteMany({ where });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}
