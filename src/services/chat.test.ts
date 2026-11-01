import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { makeTestUser, cleanupTestUsers } from "@/test-utils/db-fixtures";
import {
  createChat,
  listChats,
  getChat,
  updateChat,
  deleteChat,
} from "./chat";

const createdUserIds: string[] = [];
afterAll(() => cleanupTestUsers(createdUserIds));

async function user(label: string) {
  const u = await makeTestUser(label);
  createdUserIds.push(u.id);
  return u;
}

describe("createChat", () => {
  it("creates a chat with an optional title", async () => {
    const owner = await user("create-a");
    const chat = await createChat(owner.id, { title: "My chat" });
    expect(chat.title).toBe("My chat");
    expect(chat.isPinned).toBe(false);
  });

  it("creates a chat with no title at all", async () => {
    const owner = await user("create-b");
    const chat = await createChat(owner.id, {});
    expect(chat.title).toBeNull();
  });
});

describe("listChats", () => {
  it("orders by most recent activity, deterministically tie-broken by id", async () => {
    const owner = await user("list-order");
    const tie = new Date("2026-01-01T00:00:00.000Z");
    const earlier = new Date("2025-12-01T00:00:00.000Z");

    const a = await prisma.chat.create({ data: { userId: owner.id, lastMessageAt: tie } });
    const b = await prisma.chat.create({ data: { userId: owner.id, lastMessageAt: tie } });
    await prisma.chat.create({ data: { userId: owner.id, lastMessageAt: earlier } });

    const result = await listChats(owner.id, { limit: 20 });
    const ids = result.items.map((c) => c.id);
    // Both tie-timestamped chats come before the earlier one, and their
    // relative order between each other is id-DESC, not insertion order —
    // exactly what makes the ordering deterministic under a real tie.
    const [first, second] = [a.id, b.id].sort().reverse();
    expect(ids.slice(0, 2)).toEqual([first, second]);
  });

  it("sorts pinned chats before unpinned ones regardless of recency", async () => {
    const owner = await user("list-pinned");
    await prisma.chat.create({
      data: { userId: owner.id, lastMessageAt: new Date("2026-06-01") },
    });
    const pinned = await prisma.chat.create({
      data: { userId: owner.id, isPinned: true, lastMessageAt: new Date("2020-01-01") },
    });

    const result = await listChats(owner.id, { limit: 20 });
    expect(result.items[0].id).toBe(pinned.id);
  });

  it("paginates deterministically — no gaps, no duplicates across pages", async () => {
    const owner = await user("list-paginate");
    const base = new Date("2026-01-01T00:00:00.000Z").getTime();
    const created = [];
    for (let i = 0; i < 5; i++) {
      created.push(
        await prisma.chat.create({
          data: { userId: owner.id, lastMessageAt: new Date(base - i * 1000) },
        }),
      );
    }

    const page1 = await listChats(owner.id, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listChats(owner.id, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.items).toHaveLength(2);

    const page3 = await listChats(owner.id, { limit: 2, cursor: page2.nextCursor! });
    expect(page3.hasMore).toBe(false);

    const allIds = [...page1.items, ...page2.items, ...page3.items].map((c) => c.id);
    expect(new Set(allIds).size).toBe(allIds.length); // no duplicates
    expect(allIds.sort()).toEqual(created.map((c) => c.id).sort()); // no gaps
  });

  it("rejects an invalid cursor", async () => {
    const owner = await user("list-bad-cursor");
    await expect(
      listChats(owner.id, { limit: 20, cursor: "not-a-real-cursor" }),
    ).rejects.toThrow(ValidationError);
  });

  it("never returns another user's chats", async () => {
    const owner = await user("list-isolation-owner");
    const other = await user("list-isolation-other");
    await prisma.chat.create({ data: { userId: owner.id } });

    const result = await listChats(other.id, { limit: 20 });
    expect(result.items).toHaveLength(0);
  });
});

describe("getChat / updateChat / deleteChat", () => {
  it("retrieves a chat for its owner", async () => {
    const owner = await user("get-owner");
    const chat = await createChat(owner.id, { title: "x" });
    const got = await getChat(owner.id, chat.id);
    expect(got.id).toBe(chat.id);
  });

  it("rejects retrieval by a different user", async () => {
    const owner = await user("get-owner-2");
    const intruder = await user("get-intruder");
    const chat = await createChat(owner.id, {});
    await expect(getChat(intruder.id, chat.id)).rejects.toThrow(NotFoundError);
  });

  it("updates the title", async () => {
    const owner = await user("update-title");
    const chat = await createChat(owner.id, { title: "old" });
    const updated = await updateChat(owner.id, chat.id, { title: "new" });
    expect(updated.title).toBe("new");
  });

  it("pins and unpins", async () => {
    const owner = await user("update-pin");
    const chat = await createChat(owner.id, {});
    const pinned = await updateChat(owner.id, chat.id, { isPinned: true });
    expect(pinned.isPinned).toBe(true);
    const unpinned = await updateChat(owner.id, chat.id, { isPinned: false });
    expect(unpinned.isPinned).toBe(false);
  });

  it("rejects updating a chat owned by someone else", async () => {
    const owner = await user("update-owner");
    const intruder = await user("update-intruder");
    const chat = await createChat(owner.id, {});
    await expect(
      updateChat(intruder.id, chat.id, { title: "stolen" }),
    ).rejects.toThrow(NotFoundError);
  });

  it("soft-deletes: no longer listed or retrievable, but not hard-deleted", async () => {
    const owner = await user("delete-owner");
    const chat = await createChat(owner.id, { title: "to delete" });

    await deleteChat(owner.id, chat.id);

    await expect(getChat(owner.id, chat.id)).rejects.toThrow(NotFoundError);
    const listed = await listChats(owner.id, { limit: 20 });
    expect(listed.items.find((c) => c.id === chat.id)).toBeUndefined();

    const raw = await prisma.chat.findUnique({ where: { id: chat.id } });
    expect(raw).not.toBeNull();
    expect(raw!.isDeleted).toBe(true);
  });
});

describe("search", () => {
  it("matches chats by title", async () => {
    const owner = await user("search-title");
    const match = await createChat(owner.id, { title: "Halloween costume ideas" });
    await createChat(owner.id, { title: "Tax return questions" });

    const result = await listChats(owner.id, { limit: 20, q: "halloween" });
    expect(result.items.map((c) => c.id)).toEqual([match.id]);
  });

  it("matches chats by message content, not only title", async () => {
    const owner = await user("search-content");
    const chat = await createChat(owner.id, { title: "Untitled" });
    await prisma.message.create({
      data: {
        chatId: chat.id,
        userId: owner.id,
        role: "USER",
        content: [{ type: "text", text: "can you crop this image to a square" }],
      },
    });
    const other = await createChat(owner.id, { title: "Unrelated" });
    await prisma.message.create({
      data: {
        chatId: other.id,
        userId: owner.id,
        role: "USER",
        content: [{ type: "text", text: "what's the weather like" }],
      },
    });

    const result = await listChats(owner.id, { limit: 20, q: "crop" });
    expect(result.items.map((c) => c.id)).toEqual([chat.id]);
  });

  it("only searches within the caller's own chats", async () => {
    const owner = await user("search-isolation-owner");
    const other = await user("search-isolation-other");
    await createChat(owner.id, { title: "shared keyword zephyr" });

    const result = await listChats(other.id, { limit: 20, q: "zephyr" });
    expect(result.items).toHaveLength(0);
  });
});
