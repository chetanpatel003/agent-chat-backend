import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { makeTestUser, cleanupTestUsers, linkSentUploads } from "@/test-utils/db-fixtures";
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

    const context = await buildConversationContext(chat.id, owner.id);
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

    const context = await buildConversationContext(chat.id, owner.id);
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

    const context = await buildConversationContext(chat.id, owner.id);
    expect(context).toHaveLength(1);
    expect(context[0].content).toBe("the answer");
    expect(context[0].content).not.toContain("internal scratch reasoning");
  });

  it("does not show the model a past reply's echoed media URLs or copied file list", async () => {
    const owner = await user("context-strip-media");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    await prisma.message.create({
      data: {
        chatId: chat.id, userId: owner.id, role: "ASSISTANT", status: "COMPLETE",
        content: [{ type: "text", text: "I've generated the image:\n\nhttps://g.tlcdn.com/gen/171dd3a33e2f4c50a0f1e9a7d2c5bb98.png\n\nA sunset.\n\nGenerated files (in order):\n1. image/png https://s3.us-east-005.backblazeb2.com/b/generated/x/y-0.png?X-Amz-Credential=FAKE&X-Amz-Signature=deadbeef" }],
      },
    });

    const context = await buildConversationContext(chat.id, owner.id);
    expect(context).toEqual([{ role: "assistant", content: "I've generated the image:\n\nA sunset." }]);
  });

  it("lists a user message's ready uploads, in order with their verified type and URL, so the model can pass them to tools", async () => {
    const owner = await user("context-attachments");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const message = await prisma.message.create({
      data: {
        chatId: chat.id, userId: owner.id, role: "USER", status: "COMPLETE",
        content: [{ type: "text", text: "merge these" }],
      },
    });
    const base = { userId: owner.id, chatId: chat.id, messageId: message.id, source: "UPLOAD" as const };
    await prisma.attachment.createMany({
      data: [
        { ...base, status: "READY", mimeType: "video/mp4", url: "https://tmp.example/b.mp4", order: 1 },
        { ...base, status: "READY", mimeType: "video/mp4", url: "https://tmp.example/a.mp4", order: 0 },
        { ...base, status: "FAILED", mimeType: "video/mp4", url: null, order: 2 },
      ],
    });
    await linkSentUploads(message.id);

    const [context] = await buildConversationContext(chat.id, owner.id);
    expect(context.content).toBe(
      "merge these\n\nAttached files (in order):\n1. video/mp4 https://tmp.example/a.mp4\n2. video/mp4 https://tmp.example/b.mp4",
    );
  });
});

describe("buildConversationContext — media-library picks", () => {
  it("lists a user message's picks in send order with signed URLs, including a generated file from the library", async () => {
    const owner = await user("context-library");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const earlier = await prisma.message.create({
      data: { chatId: chat.id, userId: owner.id, role: "ASSISTANT", status: "COMPLETE", content: [{ type: "text", text: "made it" }] },
    });
    const archived = (prefix: string) => ({
      userId: owner.id,
      chatId: chat.id,
      messageId: earlier.id,
      status: "READY" as const,
      mimeType: "image/png",
      url: "https://provider.example.test/raw.png",
      storageKey: `${prefix}/${owner.id}/${crypto.randomUUID()}.png`,
      order: 0,
    });
    const generated = await prisma.attachment.create({ data: { ...archived("generated"), source: "GENERATED" } });
    const upload = await prisma.attachment.create({ data: { ...archived("uploads"), source: "UPLOAD" } });
    const message = await prisma.message.create({
      data: { chatId: chat.id, userId: owner.id, role: "USER", status: "COMPLETE", content: [{ type: "text", text: "use these" }] },
    });
    await prisma.messageAttachment.createMany({
      data: [
        { messageId: message.id, attachmentId: generated.id, order: 0 },
        { messageId: message.id, attachmentId: upload.id, order: 1 },
      ],
    });

    const context = await buildConversationContext(chat.id, owner.id);
    const userTurn = context.find((m) => typeof m.content === "string" && m.content.startsWith("use these"));
    expect(userTurn?.content).toMatch(
      new RegExp(
        `^use these\\n\\nAttached files \\(in order\\):\\n1\\. image/png \\S+/${generated.storageKey}\\?\\S+\\n2\\. image/png \\S+/${upload.storageKey}\\?`,
      ),
    );
    expect(JSON.stringify(context)).not.toContain("provider.example.test");
  });
});
