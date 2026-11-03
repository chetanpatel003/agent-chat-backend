import { describe, it, expect, vi, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/trigger/run-agent-turn", () => ({
  runAgentTurn: { trigger: vi.fn(() => Promise.resolve({ id: `run_mocked_${randomUUID()}` })) },
}));

// Title generation is dispatched after every first message; never let a test reach Trigger.dev through it.
vi.mock("@/trigger/generate-chat-title", () => ({ dispatchChatTitle: vi.fn().mockResolvedValue(true) }));
import { prisma } from "@/lib/prisma";
import { NotFoundError } from "@/lib/errors";
import { makeTestUser, cleanupTestUsers } from "@/test-utils/db-fixtures";
import { createCompletion } from "./completion";

const createdUserIds: string[] = [];
afterAll(() => cleanupTestUsers(createdUserIds));
async function user(label: string) {
  const u = await makeTestUser(label);
  createdUserIds.push(u.id);
  return u;
}

describe("createCompletion", () => {
  it("without a chatId creates a chat, admits the turn and returns run links; a retry reuses both", async () => {
    const owner = await user("completion-new");
    const key = randomUUID();
    const first = await createCompletion(owner.id, key, { text: "hello", attachmentIds: [], planMode: false });
    expect(first).toMatchObject({ status: "QUEUED", links: { run: `/api/v1/chats/${first.chatId}/runs/${first.runId}` } });
    const retry = await createCompletion(owner.id, key, { text: "hello", attachmentIds: [], planMode: false });
    expect(retry).toEqual(first);
    expect(await prisma.chat.count({ where: { userId: owner.id } })).toBe(1);
  });

  it("with a chatId submits into that chat; someone else's chat is not found", async () => {
    const owner = await user("completion-existing");
    const intruder = await user("completion-intruder");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const done = await createCompletion(owner.id, randomUUID(), { chatId: chat.id, text: "more", attachmentIds: [], planMode: false });
    expect(done.chatId).toBe(chat.id);
    await expect(
      createCompletion(intruder.id, randomUUID(), { chatId: chat.id, text: "x", attachmentIds: [], planMode: false }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
