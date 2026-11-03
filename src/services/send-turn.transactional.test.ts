// sendTurn()'s own transactional/idempotency-key/ownership behavior,
// independent of whether the dispatched task ever actually runs —
// `runAgentTurn.trigger` is mocked at the module level. A `vi.spyOn` on
// the Trigger.dev task object was tried first and didn't actually
// intercept the call site inside send-turn.ts (confirmed empirically —
// the call still took 5+ real seconds and the spy's own call count
// stayed at 0), so this is a full module mock instead, split into its
// own file so send-turn.test.ts can stay genuinely real without this
// file's tests paying for a dispatch they don't need.
import { describe, it, expect, vi, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/trigger/run-agent-turn", () => ({
  // A fresh id per call, not one fixed value for the whole file —
  // AgentRun.triggerRunId is unique; only one test here dispatches
  // successfully today, but a fixed value is a landmine for the next
  // test added that does too (checkpoint 2.4 hit exactly this in
  // send.test.ts).
  runAgentTurn: { trigger: vi.fn(() => Promise.resolve({ id: `run_mocked_${randomUUID()}` })) },
}));

// Title generation is dispatched after every first message; never let a test reach Trigger.dev through it.
vi.mock("@/trigger/generate-chat-title", () => ({ dispatchChatTitle: vi.fn().mockResolvedValue(true) }));
import { runAgentTurn } from "@/trigger/run-agent-turn";
import { prisma } from "@/lib/prisma";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { makeTestUser, cleanupTestUsers } from "@/test-utils/db-fixtures";
import { sendTurn } from "./send-turn";
import { listMessages } from "./message";

const mockTrigger = vi.mocked(runAgentTurn.trigger);
const createdUserIds: string[] = [];
afterAll(() => cleanupTestUsers(createdUserIds));

async function user(label: string) {
  const u = await makeTestUser(label);
  createdUserIds.push(u.id);
  return u;
}

describe("sendTurn — transactional behavior (dispatch mocked)", () => {
  it("is idempotent — the same Idempotency-Key returns the same dispatch, never a second run, message, or trigger call", async () => {
    const owner = await user("send-idempotent");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const key = randomUUID();

    const first = await sendTurn(owner.id, chat.id, key, { text: "once" });
    const second = await sendTurn(owner.id, chat.id, key, { text: "once (retried)" });

    expect(mockTrigger).toHaveBeenCalledTimes(1); // the retry never dispatches again
    expect(second).toEqual(first);
    expect(await prisma.agentRun.count({ where: { chatId: chat.id } })).toBe(1);
    expect(
      await prisma.message.count({ where: { chatId: chat.id, role: "USER" } }),
    ).toBe(1);
  });

  it("rejects a second send while a run is already active for the chat, creating no second run or trigger call", async () => {
    const owner = await user("send-conflict");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    await prisma.agentRun.create({
      data: {
        chatId: chat.id,
        userId: owner.id,
        idempotencyKey: randomUUID(),
        status: "RUNNING",
      },
    });

    mockTrigger.mockClear();
    await expect(
      sendTurn(owner.id, chat.id, randomUUID(), { text: "hi" }),
    ).rejects.toThrow(ConflictError);
    expect(await prisma.agentRun.count({ where: { chatId: chat.id } })).toBe(1);
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("rejects sending to a chat owned by someone else, without dispatching", async () => {
    const owner = await user("send-owner");
    const intruder = await user("send-intruder");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });

    mockTrigger.mockClear();
    await expect(
      sendTurn(intruder.id, chat.id, randomUUID(), { text: "hi" }),
    ).rejects.toThrow(NotFoundError);
    expect(mockTrigger).not.toHaveBeenCalled();
  });
});

describe("sendTurn — attachments (dispatch mocked)", () => {
  async function upload(userId: string, status: "READY" | "FAILED" = "READY", mimeType = "image/png") {
    return prisma.attachment.create({
      data: {
        userId,
        source: "UPLOAD",
        status,
        mimeType,
        sizeBytes: BigInt(10),
        url: status === "READY" ? `https://tmp.transloadit.net/${randomUUID()}` : null,
        order: 0,
      },
    });
  }

  it("binds ready uploads to the user message in order, and an idempotent retry still returns the original dispatch", async () => {
    const owner = await user("send-attach");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const video = await upload(owner.id, "READY", "video/mp4");
    const image = await upload(owner.id);
    const key = randomUUID();

    const first = await sendTurn(owner.id, chat.id, key, { text: "merge", attachmentIds: [video.id, image.id] });
    const rows = await prisma.attachment.findMany({ where: { messageId: first.messageId }, orderBy: { order: "asc" } });
    expect(rows.map((r) => r.id)).toEqual([video.id, image.id]);

    const retried = await sendTurn(owner.id, chat.id, key, { text: "merge", attachmentIds: [video.id, image.id] });
    expect(retried).toEqual(first);
  });

  it("rejects a failed upload atomically — no message, no run, no dispatch", async () => {
    const owner = await user("send-attach-failed");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const failed = await upload(owner.id, "FAILED");
    mockTrigger.mockClear();

    await expect(
      sendTurn(owner.id, chat.id, randomUUID(), { text: "x", attachmentIds: [failed.id] }),
    ).rejects.toThrow(ValidationError);
    expect(await prisma.message.count({ where: { chatId: chat.id } })).toBe(0);
    expect(await prisma.agentRun.count({ where: { chatId: chat.id } })).toBe(0);
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("rejects another user's upload as not found, without dispatching", async () => {
    const owner = await user("send-attach-owner");
    const intruder = await user("send-attach-intruder");
    const theirs = await upload(owner.id);
    const chat = await prisma.chat.create({ data: { userId: intruder.id } });
    mockTrigger.mockClear();

    await expect(
      sendTurn(intruder.id, chat.id, randomUUID(), { text: "x", attachmentIds: [theirs.id] }),
    ).rejects.toThrow(NotFoundError);
    expect(mockTrigger).not.toHaveBeenCalled();
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: theirs.id } })).messageId).toBeNull();
  });
});

describe("sendTurn — interrupt and plan mode (dispatch mocked)", () => {
  async function chatWithActiveRun(label: string) {
    const owner = await user(label);
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    // triggerRunId null: no Trigger.dev cancel call is attempted in tests.
    const active = await prisma.agentRun.create({
      data: { chatId: chat.id, userId: owner.id, idempotencyKey: randomUUID(), status: "WAITING", waitingReason: "PLAN" },
    });
    const pending = await prisma.message.create({
      data: {
        chatId: chat.id,
        userId: owner.id,
        agentRunId: active.id,
        role: "ASSISTANT",
        status: "PENDING",
        content: [{ type: "text", text: "partial" }],
      },
    });
    const waitpoint = await prisma.waitpoint.create({
      data: {
        agentRunId: active.id,
        type: "PLAN",
        token: `tok_${randomUUID()}`,
        idempotencyKey: randomUUID(),
        payload: { plan: "partial" },
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    return { owner, chat, active, pending, waitpoint };
  }

  it("interrupt cancels the active run (content and open waitpoint included) and admits the new message atomically", async () => {
    const { owner, chat, active, pending, waitpoint } = await chatWithActiveRun("send-interrupt");
    const sent = await sendTurn(owner.id, chat.id, randomUUID(), { text: "do this instead", interruptRunId: active.id });

    const [old, msg, wp, fresh] = await Promise.all([
      prisma.agentRun.findUniqueOrThrow({ where: { id: active.id } }),
      prisma.message.findUniqueOrThrow({ where: { id: pending.id } }),
      prisma.waitpoint.findUniqueOrThrow({ where: { id: waitpoint.id } }),
      prisma.agentRun.findUniqueOrThrow({ where: { id: sent.runId } }),
    ]);
    expect(old).toMatchObject({ status: "CANCELLED", errorCode: "INTERRUPTED_BY_USER", waitingReason: null });
    expect(msg.status).toBe("CANCELLED");
    expect(msg.content).toEqual([{ type: "text", text: "partial" }]); // preserved
    expect(wp.status).toBe("CANCELLED");
    expect(fresh.status).toBe("QUEUED");
  });

  it("an interrupt retried with the same Idempotency-Key returns the first dispatch and changes nothing else", async () => {
    const { owner, chat, active } = await chatWithActiveRun("send-interrupt-retry");
    const key = randomUUID();
    const first = await sendTurn(owner.id, chat.id, key, { text: "instead", interruptRunId: active.id });
    const second = await sendTurn(owner.id, chat.id, key, { text: "instead", interruptRunId: active.id });
    expect(second).toEqual(first);
    expect(await prisma.agentRun.count({ where: { chatId: chat.id } })).toBe(2);
  });

  it("interrupting a run that already finished just sends; another chat's run id is not found", async () => {
    const { owner, chat, active } = await chatWithActiveRun("send-interrupt-finished");
    await prisma.agentRun.update({ where: { id: active.id }, data: { status: "COMPLETED", completedAt: new Date() } });
    const sent = await sendTurn(owner.id, chat.id, randomUUID(), { text: "next", interruptRunId: active.id });
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: active.id } })).status).toBe("COMPLETED");
    expect(sent.runId).not.toBe(active.id);

    const other = await prisma.chat.create({ data: { userId: owner.id } });
    await expect(
      sendTurn(owner.id, other.id, randomUUID(), { text: "x", interruptRunId: sent.runId }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await prisma.agentRun.count({ where: { chatId: other.id } })).toBe(0);
  });

  it("without interrupt, sending while a run is active is still a conflict", async () => {
    const { owner, chat } = await chatWithActiveRun("send-no-interrupt");
    await expect(sendTurn(owner.id, chat.id, randomUUID(), { text: "x" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("persists plan mode on the new run", async () => {
    const owner = await user("send-plan-mode");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const sent = await sendTurn(owner.id, chat.id, randomUUID(), { text: "plan it", planMode: true });
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: sent.runId } })).planMode).toBe(true);
  });
});

describe("sendTurn — media-library picks (dispatch mocked)", () => {
  it("sends an existing library item by id, readable after reload in send order; a retried send adds nothing", async () => {
    const owner = await user("send-library");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const origin = await prisma.message.create({
      data: { chatId: chat.id, userId: owner.id, role: "ASSISTANT", status: "COMPLETE", content: [] },
    });
    const generated = await prisma.attachment.create({
      data: {
        userId: owner.id,
        chatId: chat.id,
        messageId: origin.id,
        source: "GENERATED",
        status: "READY",
        mimeType: "image/png",
        url: "https://cdn.example.test/g.png",
        storageKey: `generated/${owner.id}/${randomUUID()}.png`,
        order: 0,
      },
    });
    const before = await prisma.attachment.count({ where: { userId: owner.id } });
    const key = randomUUID();

    const sent = await sendTurn(owner.id, chat.id, key, { text: "edit this", attachmentIds: [generated.id] });
    // The retry (same Idempotency-Key) returns the first dispatch and creates nothing.
    await prisma.agentRun.update({ where: { id: sent.runId }, data: { status: "COMPLETED", completedAt: new Date() } });
    expect(await sendTurn(owner.id, chat.id, key, { text: "edit this", attachmentIds: [generated.id] })).toEqual(sent);

    expect(await prisma.attachment.count({ where: { userId: owner.id } })).toBe(before);
    expect(await prisma.messageAttachment.findMany({ where: { attachmentId: generated.id } })).toHaveLength(1);
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: generated.id } })).messageId).toBe(origin.id);

    // Reload: the user message lists the pick; the assistant message still owns its output.
    const page = await listMessages(owner.id, chat.id, { limit: 10 });
    const userMessage = page.items.find((m) => m.id === sent.messageId);
    expect(userMessage?.attachments.map((a) => [a.id, a.source])).toEqual([[generated.id, "GENERATED"]]);
    expect(page.items.find((m) => m.id === origin.id)?.attachments.map((a) => a.id)).toEqual([generated.id]);
  });

  it("refuses another user's media without creating the message or any association", async () => {
    const owner = await user("send-library-owner");
    const intruder = await user("send-library-intruder");
    const ownerChat = await prisma.chat.create({ data: { userId: owner.id } });
    const origin = await prisma.message.create({
      data: { chatId: ownerChat.id, userId: owner.id, role: "ASSISTANT", status: "COMPLETE", content: [] },
    });
    const theirs = await prisma.attachment.create({
      data: {
        userId: owner.id,
        chatId: ownerChat.id,
        messageId: origin.id,
        source: "GENERATED",
        status: "READY",
        mimeType: "image/png",
        url: "https://cdn.example.test/g.png",
        storageKey: `generated/${owner.id}/${randomUUID()}.png`,
        order: 0,
      },
    });
    const chat = await prisma.chat.create({ data: { userId: intruder.id } });
    await expect(sendTurn(intruder.id, chat.id, randomUUID(), { text: "x", attachmentIds: [theirs.id] })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(await prisma.message.count({ where: { chatId: chat.id } })).toBe(0);
    expect(await prisma.messageAttachment.count({ where: { attachmentId: theirs.id } })).toBe(0);
  });
});

describe("sendTurn — Idempotency-Key ownership", () => {
  it("another user's key (or the same key for another chat) is a conflict, never their dispatch", async () => {
    const owner = await user("send-key-owner");
    const intruder = await user("send-key-intruder");
    const ownerChat = await prisma.chat.create({ data: { userId: owner.id } });
    const key = randomUUID();
    await sendTurn(owner.id, ownerChat.id, key, { text: "mine" });

    const intruderChat = await prisma.chat.create({ data: { userId: intruder.id } });
    await expect(sendTurn(intruder.id, intruderChat.id, key, { text: "x" })).rejects.toBeInstanceOf(ConflictError);
    const otherChat = await prisma.chat.create({ data: { userId: owner.id } });
    await expect(sendTurn(owner.id, otherChat.id, key, { text: "x" })).rejects.toBeInstanceOf(ConflictError);
    expect(await prisma.message.count({ where: { chatId: { in: [intruderChat.id, otherChat.id] } } })).toBe(0);
  });
});
