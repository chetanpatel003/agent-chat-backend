import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { makeTestUser, cleanupTestUsers, linkSentUploads } from "@/test-utils/db-fixtures";
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

  it("strips previously persisted thinking/reasoning blocks from the response payload", async () => {
    const owner = await user("strip-reasoning");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    await prisma.message.create({
      data: {
        chatId: chat.id,
        userId: owner.id,
        role: "ASSISTANT",
        content: [
          { type: "thinking", text: "Let me check the available tools." },
          { type: "reasoning", text: "private summary" },
          { type: "text", text: "Hello!" },
        ],
      },
    });

    const page = await listMessages(owner.id, chat.id, { limit: 10 });
    expect(page.items[0].content).toEqual([{ type: "text", text: "Hello!" }]);
    expect(JSON.stringify(page)).not.toContain("Let me check the available tools.");
    expect(JSON.stringify(page)).not.toContain("private summary");
  });

  it("never returns generated-media or signed URLs in assistant prose (stored text is left as is)", async () => {
    const owner = await user("strip-media-urls");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const base = Date.now();
    await prisma.message.create({
      data: { chatId: chat.id, userId: owner.id, role: "USER", content: [{ type: "text", text: "edit https://g.tlcdn.com/gen/mine.png" }], createdAt: new Date(base) },
    });
    const leaked = await prisma.message.create({
      data: {
        chatId: chat.id, userId: owner.id, role: "ASSISTANT", createdAt: new Date(base + 1000),
        content: [{ type: "text", text: "I've generated the image:\n\nhttps://g.tlcdn.com/gen/171dd3a33e2f4c50a0f1e9a7d2c5bb98.png\n\nA sunset.\n\nGenerated files (in order):\n1. image/png https://s3.us-east-005.backblazeb2.com/b/generated/x/y-0.png?X-Amz-Credential=FAKE&X-Amz-Signature=deadbeef" }],
      },
    });

    const page = await listMessages(owner.id, chat.id, { limit: 10 });
    expect(page.items[1].content).toEqual([{ type: "text", text: "I've generated the image:\n\nA sunset." }]);
    expect(JSON.stringify(page.items[1])).not.toMatch(/X-Amz|backblazeb2|tlcdn|Generated files/);
    // The user's own text is theirs: unchanged.
    expect(page.items[0].content).toEqual([{ type: "text", text: "edit https://g.tlcdn.com/gen/mine.png" }]);
    // Nothing persisted was rewritten.
    const stored = await prisma.message.findUniqueOrThrow({ where: { id: leaked.id } });
    expect(JSON.stringify(stored.content)).toContain("X-Amz-Signature");
  });

  it("shows usage settled after the turn wrote its tool_result (read from ToolInvocation; stored block untouched)", async () => {
    const owner = await user("late-settlement");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const run = await prisma.agentRun.create({ data: { chatId: chat.id, userId: owner.id, idempotencyKey: randomUUID(), status: "COMPLETED" } });
    const message = await prisma.message.create({ data: { chatId: chat.id, userId: owner.id, agentRunId: run.id, role: "ASSISTANT", content: [] } });
    const other = await prisma.message.create({ data: { chatId: chat.id, userId: owner.id, agentRunId: run.id, role: "SYSTEM", content: [] } });
    const invocation = (opts: { messageId: string; charged: bigint | null }) =>
      prisma.toolInvocation.create({
        data: {
          agentRunId: run.id, messageId: opts.messageId, toolName: "generate_image", idempotencyKey: randomUUID(), input: {}, status: "COMPLETED",
          ...(opts.charged === null ? {} : { creditsUsed: opts.charged, creditsCharged: opts.charged }),
        },
      });
    const lateSettled = await invocation({ messageId: message.id, charged: BigInt(273_936) });
    const unsettled = await invocation({ messageId: message.id, charged: null });
    const foreign = await invocation({ messageId: other.id, charged: BigInt(999) }); // belongs to another message
    const result = (id: string, creditsCharged: number | null) => ({ type: "tool_result", toolInvocationId: id, output: null, durationMs: 1, creditsCharged, error: null });
    await prisma.message.update({
      where: { id: message.id },
      data: {
        content: [
          result(lateSettled.id, null),
          result(unsettled.id, null),
          result(foreign.id, null),
          { type: "text", text: "Here is your image. It used 273936 credits." },
        ],
      },
    });

    const page = await listMessages(owner.id, chat.id, { limit: 10 });
    const item = page.items.find((m) => m.id === message.id);
    const charges = item?.content.flatMap((b) => (b.type === "tool_result" ? [b.creditsCharged] : []));
    expect(charges).toEqual([273_936, null, null]); // settled shown; unsettled/foreign never invented
    expect(item?.content.at(-1)).toEqual({ type: "text", text: "Here is your image." });
    const stored = await prisma.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(JSON.stringify(stored.content)).toContain('"creditsCharged":null');
    expect(JSON.stringify(stored.content)).toContain("It used 273936 credits.");
  });

  it("returns each message's attachments in attachment order", async () => {
    const owner = await user("list-attachments");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const message = await prisma.message.create({
      data: { chatId: chat.id, userId: owner.id, role: "USER", content: [{ type: "text", text: "see" }] },
    });
    const base = { userId: owner.id, chatId: chat.id, messageId: message.id, source: "UPLOAD" as const, status: "READY" as const };
    await prisma.attachment.createMany({
      data: [
        { ...base, mimeType: "image/png", url: "https://tmp.example/2.png", order: 1, sanitizedMetadata: { filename: "2.png" } },
        { ...base, mimeType: "image/png", url: "https://tmp.example/1.png", order: 0, sanitizedMetadata: { filename: "1.png" } },
      ],
    });
    await linkSentUploads(message.id);

    const page = await listMessages(owner.id, chat.id, { limit: 10 });
    expect(page.items[0].attachments.map((a) => [a.order, a.metadata.filename])).toEqual([
      [0, "1.png"],
      [1, "2.png"],
    ]);
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

describe("listMessages — run outcome fields", () => {
  it("a CANCELLED/FAILED assistant message carries its run's safe reason; thinkingMs is exposed; COMPLETE has no error", async () => {
    const owner = await user("msg-run-error");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const expired = await prisma.agentRun.create({
      data: {
        chatId: chat.id,
        userId: owner.id,
        idempotencyKey: crypto.randomUUID(),
        status: "CANCELLED",
        errorCode: "WAITPOINT_EXPIRED",
        errorMessage: "Send a new message to continue.",
      },
    });
    await prisma.message.create({
      data: {
        chatId: chat.id,
        userId: owner.id,
        agentRunId: expired.id,
        role: "ASSISTANT",
        status: "CANCELLED",
        thinkingMs: 1234,
        content: [{ type: "text", text: "1. Plan" }],
      },
    });
    const ok = await prisma.agentRun.create({
      data: { chatId: chat.id, userId: owner.id, idempotencyKey: crypto.randomUUID(), status: "COMPLETED", errorCode: "IGNORED" },
    });
    await prisma.message.create({
      data: { chatId: chat.id, userId: owner.id, agentRunId: ok.id, role: "ASSISTANT", status: "COMPLETE", content: [] },
    });

    const page = await listMessages(owner.id, chat.id, { limit: 10 });
    const [cancelled, complete] = page.items;
    expect(cancelled.error).toEqual({ code: "WAITPOINT_EXPIRED", message: "Send a new message to continue." });
    expect(cancelled.thinkingMs).toBe(1234);
    expect(complete.error).toBeNull();
    expect(complete.thinkingMs).toBeNull();
  });
});

describe("listMessages — runDurationMs (measured, never estimated)", () => {
  it("is run creation → completion for a finished turn, null while active, null for a late-recovered result, null for user messages", async () => {
    const owner = await user("msg-run-duration");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const t0 = new Date("2026-11-04T10:00:00.000Z");
    const run = (status: "COMPLETED" | "RUNNING" | "FAILED", completedAt: Date | null) =>
      prisma.agentRun.create({
        data: {
          chatId: chat.id,
          userId: owner.id,
          idempotencyKey: randomUUID(),
          status,
          createdAt: t0,
          startedAt: new Date(t0.getTime() + 2_500), // 2.5 s queued before the worker picked it up
          completedAt,
        },
      });
    // A long Merge Videos turn: ~4 s thinking, minutes of tool work.
    const merged = await run("COMPLETED", new Date(t0.getTime() + 192_500));
    const active = await run("RUNNING", null);
    const recovered = await run("FAILED", new Date(t0.getTime() + 60_000));
    const assistant = (agentRunId: string, status: "COMPLETE" | "PENDING", at: number) =>
      prisma.message.create({
        data: { chatId: chat.id, userId: owner.id, agentRunId, role: "ASSISTANT", status, thinkingMs: 4_000, content: [], createdAt: new Date(t0.getTime() + at) },
      });
    await prisma.message.create({ data: { chatId: chat.id, userId: owner.id, role: "USER", content: [{ type: "text", text: "merge" }], createdAt: t0 } });
    await assistant(merged.id, "COMPLETE", 1);
    await assistant(active.id, "PENDING", 2);
    await assistant(recovered.id, "COMPLETE", 3); // result attached after the run ended (H2)

    const [userMsg, mergedMsg, activeMsg, recoveredMsg] = (await listMessages(owner.id, chat.id, { limit: 10 })).items;
    expect(userMsg.runDurationMs).toBeNull();
    expect(mergedMsg.runDurationMs).toBe(192_500);
    expect(mergedMsg.thinkingMs).toBe(4_000); // model time stays separate
    expect(mergedMsg.runQueueMs).toBe(2_500); // queue time, measured separately
    expect(activeMsg.runQueueMs).toBe(2_500);
    expect(userMsg.runQueueMs).toBeNull();
    expect(activeMsg.runDurationMs).toBeNull();
    expect(recoveredMsg.runDurationMs).toBeNull();
  });
});

describe("listMessages — PENDING message of an ended run", () => {
  it("carries the run's reason once the run has ended, and none while the run is still active", async () => {
    const owner = await user("msg-pending-ended");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const ended = await prisma.agentRun.create({
      data: {
        chatId: chat.id,
        userId: owner.id,
        idempotencyKey: crypto.randomUUID(),
        status: "FAILED",
        errorCode: "RUN_INTERRUPTED",
        errorMessage: "The execution stopped unexpectedly. Send a new message to continue.",
      },
    });
    await prisma.message.create({
      data: { chatId: chat.id, userId: owner.id, agentRunId: ended.id, role: "ASSISTANT", status: "PENDING", content: [] },
    });
    const live = await prisma.agentRun.create({
      data: { chatId: chat.id, userId: owner.id, idempotencyKey: crypto.randomUUID(), status: "RUNNING", errorCode: "STALE" },
    });
    await prisma.message.create({
      data: { chatId: chat.id, userId: owner.id, agentRunId: live.id, role: "ASSISTANT", status: "PENDING", content: [] },
    });

    const [first, second] = (await listMessages(owner.id, chat.id, { limit: 10 })).items;
    expect(first).toMatchObject({ status: "PENDING", error: { code: "RUN_INTERRUPTED" } });
    expect(second).toMatchObject({ status: "PENDING", error: null });
  });
});

describe("listMessages — tool display names", () => {
  it("adds each tool_use block's user-facing name on read (persisted content unchanged)", async () => {
    const owner = await user("msg-tool-display");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const id = randomUUID();
    const content = [
      { type: "tool_use", toolInvocationId: id, toolName: "merge_videos", status: "COMPLETED", input: {} },
      { type: "tool_use", toolInvocationId: randomUUID(), toolName: "some_future_tool", status: "COMPLETED", input: {} },
    ];
    const created = await prisma.message.create({ data: { chatId: chat.id, userId: owner.id, role: "ASSISTANT", content } });

    const [message] = (await listMessages(owner.id, chat.id, { limit: 10 })).items;
    const uses = message.content.filter((b) => b.type === "tool_use");
    expect(uses.map((b) => b.type === "tool_use" && b.displayName)).toEqual(["Merge Videos", "Some future tool"]);
    const stored = await prisma.message.findUniqueOrThrow({ where: { id: created.id } });
    expect(JSON.stringify(stored.content)).not.toContain("displayName");
  });
});
