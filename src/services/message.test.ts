import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { makeTestUser, cleanupTestUsers } from "@/test-utils/db-fixtures";
import { listMessages } from "./message";

const createdUserIds: string[] = [];
afterAll(() => cleanupTestUsers(createdUserIds));

async function user(label: string) {
  const u = await makeTestUser(label);
  createdUserIds.push(u.id);
  return u;
}

async function makeChatWithMessages(
  userId: string,
  texts: { text: string; createdAt: Date }[],
) {
  const chat = await prisma.chat.create({ data: { userId } });
  for (const { text, createdAt } of texts) {
    await prisma.message.create({
      data: {
        chatId: chat.id,
        userId,
        role: "USER",
        content: [{ type: "text", text }],
        createdAt,
      },
    });
  }
  return chat;
}

describe("listMessages", () => {
  it("returns the first page in chronological (oldest-first) order", async () => {
    const owner = await user("first-page");
    const base = new Date("2026-01-01T00:00:00.000Z").getTime();
    const chat = await makeChatWithMessages(
      owner.id,
      [0, 1, 2, 3].map((i) => ({ text: `m${i}`, createdAt: new Date(base + i * 1000) })),
    );

    const page = await listMessages(owner.id, chat.id, { limit: 10 });
    expect(page.items.map((m) => (m.content[0] as { text: string }).text)).toEqual([
      "m0",
      "m1",
      "m2",
      "m3",
    ]);
    expect(page.hasMore).toBe(false);
    expect(page.olderCursor).toBeNull();
  });

  it("paginates backward with olderCursor, items still chronological within each page", async () => {
    const owner = await user("older-page");
    const base = new Date("2026-01-01T00:00:00.000Z").getTime();
    const chat = await makeChatWithMessages(
      owner.id,
      [0, 1, 2, 3, 4].map((i) => ({ text: `m${i}`, createdAt: new Date(base + i * 1000) })),
    );

    // First page: the 2 most recent (m3, m4), returned oldest-first.
    const page1 = await listMessages(owner.id, chat.id, { limit: 2 });
    expect(page1.items.map((m) => (m.content[0] as { text: string }).text)).toEqual([
      "m3",
      "m4",
    ]);
    expect(page1.hasMore).toBe(true);
    expect(page1.olderCursor).not.toBeNull();

    // Older page: strictly before m3 — m1, m2, oldest-first.
    const page2 = await listMessages(owner.id, chat.id, {
      limit: 2,
      cursor: page1.olderCursor!,
    });
    expect(page2.items.map((m) => (m.content[0] as { text: string }).text)).toEqual([
      "m1",
      "m2",
    ]);
    expect(page2.hasMore).toBe(true);

    const page3 = await listMessages(owner.id, chat.id, {
      limit: 2,
      cursor: page2.olderCursor!,
    });
    expect(page3.items.map((m) => (m.content[0] as { text: string }).text)).toEqual(["m0"]);
    expect(page3.hasMore).toBe(false);
  });

  it("stays deterministic when two messages share the exact same timestamp", async () => {
    const owner = await user("tie-break");
    const tie = new Date("2026-03-01T00:00:00.000Z");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const a = await prisma.message.create({
      data: { chatId: chat.id, userId: owner.id, role: "USER", content: [], createdAt: tie },
    });
    const b = await prisma.message.create({
      data: { chatId: chat.id, userId: owner.id, role: "USER", content: [], createdAt: tie },
    });

    const page = await listMessages(owner.id, chat.id, { limit: 10 });
    // Within the tie, ascending id order (the reverse of the DESC-query
    // tie-break) — deterministic either way, just needs to be consistent.
    const expectedOrder = [a.id, b.id].sort();
    expect(page.items.map((m) => m.id)).toEqual(expectedOrder);
  });

  it("returns an empty page for a chat with no messages", async () => {
    const owner = await user("empty-history");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const page = await listMessages(owner.id, chat.id, { limit: 10 });
    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.olderCursor).toBeNull();
  });

  it("rejects access to another user's chat history", async () => {
    const owner = await user("history-owner");
    const intruder = await user("history-intruder");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    await expect(listMessages(intruder.id, chat.id, { limit: 10 })).rejects.toThrow(
      NotFoundError,
    );
  });

  it("rejects an invalid cursor", async () => {
    const owner = await user("history-bad-cursor");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    await expect(
      listMessages(owner.id, chat.id, { limit: 10, cursor: "garbage" }),
    ).rejects.toThrow(ValidationError);
  });
});
