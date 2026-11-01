import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { requireChatOwnership, requireMessageOwnership } from "./ownership";
import { NotFoundError } from "@/lib/errors";

const createdUserIds: string[] = [];

afterAll(async () => {
  if (createdUserIds.length) {
    // Respect ON DELETE RESTRICT: children before the User row itself.
    await prisma.message.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.chat.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
});

async function makeTestUser(label: string) {
  const user = await prisma.user.create({
    data: {
      clerkUserId: `test_ckpt1.2_own_${label}_${randomUUID()}`,
      email: `${label}@example.com`,
    },
  });
  createdUserIds.push(user.id);
  return user;
}

describe("requireChatOwnership", () => {
  it("returns the chat for its owner", async () => {
    const owner = await makeTestUser("owner-a");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });

    const result = await requireChatOwnership(owner.id, chat.id);
    expect(result.id).toBe(chat.id);
  });

  it("rejects a different user with NotFoundError, not a 403-style error", async () => {
    const owner = await makeTestUser("owner-b");
    const intruder = await makeTestUser("intruder-b");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });

    await expect(requireChatOwnership(intruder.id, chat.id)).rejects.toThrow(
      NotFoundError,
    );
  });

  it("rejects a nonexistent chat id with the exact same error as someone else's chat", async () => {
    // Same NotFoundError either way — the response can't be used to tell
    // "doesn't exist" apart from "exists but isn't yours".
    const user = await makeTestUser("owner-c");
    await expect(requireChatOwnership(user.id, randomUUID())).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe("requireMessageOwnership", () => {
  it("resolves ownership through the parent chat", async () => {
    const owner = await makeTestUser("owner-d");
    const intruder = await makeTestUser("intruder-d");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const message = await prisma.message.create({
      data: { chatId: chat.id, userId: owner.id, role: "USER", content: [] },
    });

    const ok = await requireMessageOwnership(owner.id, message.id);
    expect(ok.id).toBe(message.id);

    await expect(
      requireMessageOwnership(intruder.id, message.id),
    ).rejects.toThrow(NotFoundError);
  });
});
