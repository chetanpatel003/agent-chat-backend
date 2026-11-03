// Automatic chat titles. Real database; OpenRouter and Trigger.dev mocked —
// no provider is ever called.
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/trigger/run-agent-turn", () => ({
  runAgentTurn: { trigger: vi.fn(() => Promise.resolve({ id: `run_mocked_${randomUUID()}` })) },
}));
vi.mock("@/trigger/generate-chat-title", () => ({ dispatchChatTitle: vi.fn().mockResolvedValue(true) }));
// Capture work scheduled for after the response, so tests can prove it did not
// run during sendTurn and then run it explicitly ("the response has been sent").
const scheduled: { label: string; task: () => Promise<void> }[] = [];
vi.mock("@/lib/after-response", () => ({
  runAfterResponse: vi.fn((label: string, task: () => Promise<void>) => {
    scheduled.push({ label, task });
  }),
}));
vi.mock("@/providers/openrouter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/providers/openrouter")>();
  return { ...actual, callOpenRouter: vi.fn() };
});

import { prisma } from "@/lib/prisma";
import { makeTestUser, cleanupTestUsers } from "@/test-utils/db-fixtures";
import { dispatchChatTitle } from "@/trigger/generate-chat-title";
import { callOpenRouter } from "@/providers/openrouter";
import { runAfterResponse } from "@/lib/after-response";
import { sendTurn } from "./send-turn";
import { updateChat } from "./chat";
import { cleanModelTitle, fallbackTitle, generateTitle, titleChatFromFirstMessage, TITLE_MAX_CHARS } from "./chat-title";

const createdUserIds: string[] = [];
afterAll(() => cleanupTestUsers(createdUserIds));
beforeEach(() => {
  vi.mocked(dispatchChatTitle).mockClear();
  vi.mocked(callOpenRouter).mockReset();
  vi.mocked(runAfterResponse).mockClear();
  scheduled.length = 0;
});
/** "The response has been sent": run what sendTurn deferred. */
async function flushAfterResponse() {
  for (const { task } of scheduled.splice(0)) await task();
}
async function user(label: string) {
  const u = await makeTestUser(label);
  createdUserIds.push(u.id);
  return u;
}
async function chatWith(label: string, firstMessage: string | null, title: string | null = null) {
  const owner = await user(label);
  const chat = await prisma.chat.create({ data: { userId: owner.id, title } });
  if (firstMessage !== null) {
    await prisma.message.create({ data: { chatId: chat.id, userId: owner.id, role: "USER", content: [{ type: "text", text: firstMessage }] } });
  }
  return { owner, chat };
}
const reply = (text: string | null) => async () => ({ text });
const titleOf = async (id: string) => (await prisma.chat.findUniqueOrThrow({ where: { id } })).title;

describe("cleanModelTitle", () => {
  it.each([
    ["Sunset Over Gurgaon Balcony", "Sunset Over Gurgaon Balcony"],
    ['"Sunset over Gurgaon."', "Sunset over Gurgaon"],
    ["Title: Couple watching the sunset", "Couple watching the sunset"],
    ["**Image of a red bicycle**\nSecond line", "Image of a red bicycle"],
    ["one two three four five six seven eight", "One two three four five six"],
  ])("%s → %s", (raw, expected) => {
    expect(cleanModelTitle(raw)).toBe(expected);
  });

  it("caps the length on a word boundary and rejects non-titles", () => {
    const long = cleanModelTitle("Extraordinarily comprehensive investigation regarding interdisciplinary methodologies");
    expect(long!.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    expect(cleanModelTitle("")).toBeNull();
    expect(cleanModelTitle(null)).toBeNull();
    expect(cleanModelTitle("   \n  ")).toBeNull();
    expect(cleanModelTitle("This is a whole sentence the model wrote instead of giving a short title back to us")).toBeNull();
    expect(cleanModelTitle("https://example.com/x")).toBeNull();
  });
});

describe("fallbackTitle (deterministic)", () => {
  it("uses the message's meaningful opening words", () => {
    expect(fallbackTitle("Can you please generate an image of a couple on a balcony at sunset")).toBe("Generate an image of a couple");
    expect(fallbackTitle("say hello in one sentence.")).toBe("Say hello in one sentence");
    expect(fallbackTitle("crop this https://g.tlcdn.com/gen/a.png to a square")).toBe("Crop this to a square");
    expect(fallbackTitle("   ")).toBeNull();
  });
});

describe("generateTitle", () => {
  it("returns the model's cleaned title", async () => {
    expect(await generateTitle("draw a cat", reply("Cat Drawing Request"))).toEqual({ title: "Cat Drawing Request", source: "model" });
  });
  it.each([
    ["the model throws", async () => { throw new Error("rate limited"); }],
    ["the model returns nothing", reply(null)],
    ["the model returns junk", reply("Sure! Here is a great title that you might like for this conversation about cats")],
  ])("falls back when %s", async (_label, call) => {
    expect(await generateTitle("please draw a small cat", call)).toEqual({ title: "Draw a small cat", source: "fallback" });
  });
});

describe("titleChatFromFirstMessage (the task body)", () => {
  it("titles an untitled chat from its first message", async () => {
    const { chat } = await chatWith("title-first", "Generate an image of a red bicycle");
    expect(await titleChatFromFirstMessage(chat.id, reply("Red Bicycle Image"))).toBe("titled");
    expect(await titleOf(chat.id)).toBe("Red Bicycle Image");
  });

  it("uses the fallback when generation fails, so the chat still gets a sensible title", async () => {
    const { chat } = await chatWith("title-fallback", "Can you summarise this article for me");
    await titleChatFromFirstMessage(chat.id, async () => { throw new Error("provider down"); });
    expect(await titleOf(chat.id)).toBe("Summarise this article for me");
  });

  it("never overwrites a manually set title (before generation)", async () => {
    const { chat } = await chatWith("title-manual-before", "anything", "My own title");
    const call = vi.fn(reply("Model Title"));
    expect(await titleChatFromFirstMessage(chat.id, call)).toBe("already_titled");
    expect(call).not.toHaveBeenCalled();
    expect(await titleOf(chat.id)).toBe("My own title");
  });

  it("never overwrites a rename that lands while the title is being generated", async () => {
    const { owner, chat } = await chatWith("title-manual-during", "plan a trip to Goa");
    const call = async () => {
      await updateChat(owner.id, chat.id, { title: "Goa holiday (mine)" });
      return { text: "Trip Planning For Goa" };
    };
    expect(await titleChatFromFirstMessage(chat.id, call)).toBe("already_titled");
    expect(await titleOf(chat.id)).toBe("Goa holiday (mine)");
  });

  it("concurrent generations write exactly one title, never overwriting each other", async () => {
    const { chat } = await chatWith("title-concurrent", "write a haiku about rain");
    const outcomes = await Promise.all([
      titleChatFromFirstMessage(chat.id, reply("Rainy Haiku")),
      titleChatFromFirstMessage(chat.id, reply("Haiku About Rain")),
      titleChatFromFirstMessage(chat.id, reply("Rain Poem")),
    ]);
    expect(outcomes.filter((o) => o === "titled")).toHaveLength(1);
    const title = await titleOf(chat.id);
    expect(["Rainy Haiku", "Haiku About Rain", "Rain Poem"]).toContain(title);
    await titleChatFromFirstMessage(chat.id, reply("Something Else"));
    expect(await titleOf(chat.id)).toBe(title);
  });

  it("does nothing for a chat with no text message", async () => {
    const { chat } = await chatWith("title-empty", null);
    expect(await titleChatFromFirstMessage(chat.id, reply("X Y"))).toBe("no_title");
    expect(await titleOf(chat.id)).toBeNull();
  });
});

describe("sendTurn — title generation is deferred until after the response", () => {
  const send = (userId: string, chatId: string, text: string, extra: Record<string, unknown> = {}) =>
    sendTurn(userId, chatId, randomUUID(), { text, ...extra } as Parameters<typeof sendTurn>[3]);
  const endRuns = (chatId: string) => prisma.agentRun.updateMany({ where: { chatId }, data: { status: "COMPLETED", completedAt: new Date() } });

  it("schedules the check through runAfterResponse and runs nothing before sendTurn returns", async () => {
    const owner = await user("send-title-deferred");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const countSpy = vi.spyOn(prisma.message, "count");
    const sent = await send(owner.id, chat.id, "Help me plan a birthday party");

    // Response is ready: work was scheduled, but neither the eligibility
    // queries nor the Trigger.dev dispatch have run yet.
    expect(sent.runId).toBeTruthy();
    expect(runAfterResponse).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runAfterResponse).mock.calls[0][0]).toBe("chat-title");
    expect(countSpy).not.toHaveBeenCalled();
    expect(dispatchChatTitle).not.toHaveBeenCalled();

    await flushAfterResponse();
    expect(countSpy).toHaveBeenCalledTimes(1);
    expect(dispatchChatTitle).toHaveBeenCalledTimes(1);
    expect(dispatchChatTitle).toHaveBeenCalledWith(chat.id);
    countSpy.mockRestore();
  });

  it("starts it once for a new chat's first message, not for later messages", async () => {
    const owner = await user("send-title-first");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    await send(owner.id, chat.id, "Help me plan a birthday party");
    await flushAfterResponse();
    expect(dispatchChatTitle).toHaveBeenCalledTimes(1);
    await endRuns(chat.id);
    await send(owner.id, chat.id, "Make it a surprise");
    await flushAfterResponse();
    expect(dispatchChatTitle).toHaveBeenCalledTimes(1);
  });

  it("is not started for an existing chat with history, even if untitled", async () => {
    const { owner, chat } = await chatWith("send-title-existing", "an earlier message");
    await send(owner.id, chat.id, "a new message");
    await flushAfterResponse();
    expect(dispatchChatTitle).not.toHaveBeenCalled();
    expect(await titleOf(chat.id)).toBeNull();
  });

  it("is not started for a chat that already has a title", async () => {
    const owner = await user("send-title-titled");
    const chat = await prisma.chat.create({ data: { userId: owner.id, title: "Named by me" } });
    await send(owner.id, chat.id, "hello");
    await flushAfterResponse();
    expect(dispatchChatTitle).not.toHaveBeenCalled();
  });

  it("is not even scheduled for a direct tool run", async () => {
    const owner = await user("send-title-tool");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    await send(owner.id, chat.id, "Run generate_image", { directTool: { name: "generate_image", input: { prompt: "x" } } });
    expect(runAfterResponse).not.toHaveBeenCalled();
    await flushAfterResponse();
    expect(dispatchChatTitle).not.toHaveBeenCalled();
  });

  it("a failure in the deferred work never affects the already-admitted message", async () => {
    const owner = await user("send-title-fail");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    vi.mocked(dispatchChatTitle).mockRejectedValueOnce(new Error("trigger down"));
    const sent = await send(owner.id, chat.id, "still works");
    await expect(flushAfterResponse()).resolves.toBeUndefined();
    const message = await prisma.message.findUniqueOrThrow({ where: { id: sent.messageId } });
    expect([message.role, message.status]).toEqual(["USER", "COMPLETE"]);
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: sent.runId } })).triggerRunId).toBeTruthy();
  });
});
