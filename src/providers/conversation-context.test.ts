import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { makeTestUser, cleanupTestUsers } from "@/test-utils/db-fixtures";
import { buildConversationContext } from "./conversation-context";

const createdUserIds: string[] = [];
afterAll(() => cleanupTestUsers(createdUserIds));

async function user(label: string) {
  const u = await makeTestUser(label);
  createdUserIds.push(u.id);
  return u;
}

describe("buildConversationContext", () => {
  it("returns messages in chronological order, mapped to provider roles", async () => {
    const owner = await user("context-order");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const base = new Date("2026-01-01T00:00:00.000Z").getTime();
    await prisma.message.create({
      data: {
        chatId: chat.id, userId: owner.id, role: "USER", status: "COMPLETE",
        content: [{ type: "text", text: "first" }], createdAt: new Date(base),
      },
    });
    await prisma.message.create({
      data: {
        chatId: chat.id, userId: owner.id, role: "ASSISTANT", status: "COMPLETE",
        content: [{ type: "text", text: "second" }], createdAt: new Date(base + 1000),
      },
    });

    const context = await buildConversationContext(chat.id);
    expect(context).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
    ]);
  });

  it("excludes PENDING and FAILED messages — nothing usable to show the model", async () => {
    const owner = await user("context-exclude");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    await prisma.message.create({
      data: {
        chatId: chat.id, userId: owner.id, role: "USER", status: "COMPLETE",
        content: [{ type: "text", text: "visible" }],
      },
    });
    await prisma.message.create({
      data: {
        chatId: chat.id, userId: owner.id, role: "ASSISTANT", status: "PENDING",
        content: [],
      },
    });
    await prisma.message.create({
      data: {
        chatId: chat.id, userId: owner.id, role: "ASSISTANT", status: "FAILED",
        content: [],
      },
    });

    const context = await buildConversationContext(chat.id);
    expect(context).toEqual([{ role: "user", content: "visible" }]);
  });

  it("sends only the text block back as context, never the model's own thinking/reasoning", async () => {
    const owner = await user("context-reasoning");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    await prisma.message.create({
      data: {
        chatId: chat.id, userId: owner.id, role: "ASSISTANT", status: "COMPLETE",
        content: [
          { type: "thinking", text: "internal scratch reasoning" },
          { type: "text", text: "the answer" },
        ],
      },
    });

    const context = await buildConversationContext(chat.id);
    expect(context).toHaveLength(1);
    expect(context[0].content).toBe("the answer");
    expect(context[0].content).not.toContain("internal scratch reasoning");
  });
});
