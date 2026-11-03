import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { setupServer } from "msw/node";

// B2 signing is mocked: a spy around the real (offline) signer by default,
// overridable per test. No request can reach B2 — the endpoint below is a
// reserved .test host and MSW errors on any unhandled request.
vi.mock("@/lib/b2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/b2")>();
  return { ...actual, signedGetUrl: vi.fn(actual.signedGetUrl), copyUrlToObject: vi.fn(actual.copyUrlToObject) };
});

import { signedGetUrl, copyUrlToObject } from "@/lib/b2";
import { prisma } from "@/lib/prisma";
import { NotFoundError } from "@/lib/errors";
import { makeTestUser, cleanupTestUsers, linkSentUploads } from "@/test-utils/db-fixtures";
import { listMessages } from "./message";
import { AttachmentUrlUnavailableError, cancelUpload } from "./attachment";

const mockSign = vi.mocked(signedGetUrl);
const mockCopy = vi.mocked(copyUrlToObject);

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const B2_ENDPOINT = "https://s3.us-east-005.backblazeb2.test";
const B2_BUCKET = "agentChat";
const B2_SECRET = "K005FAKEAPPLICATIONKEYSECRETVAL";
const TRANSLOADIT_URL = "https://pub-e8fef8c0e03b44acb340577811800829.r2.dev/tmp/photo.png";

const ENV_KEYS = ["B2_KEY_ID", "B2_APPLICATION_KEY", "B2_BUCKET_NAME", "B2_ENDPOINT", "B2_REGION"] as const;
const ORIGINAL = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
beforeEach(() => {
  process.env.B2_KEY_ID = "0050000000000000000000001";
  process.env.B2_APPLICATION_KEY = B2_SECRET;
  process.env.B2_BUCKET_NAME = B2_BUCKET;
  process.env.B2_ENDPOINT = B2_ENDPOINT;
  process.env.B2_REGION = "us-east-005";
  mockSign.mockClear();
  mockCopy.mockClear();
});

const createdUserIds: string[] = [];
afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (ORIGINAL[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL[k];
  }
  await cleanupTestUsers(createdUserIds);
});

async function user(label: string) {
  const u = await makeTestUser(label);
  createdUserIds.push(u.id);
  return u;
}

/** A user message in the owner's chat with one READY upload attached. */
async function messageWithAttachment(ownerId: string, opts: { archived: boolean }) {
  const chat = await prisma.chat.create({ data: { userId: ownerId } });
  const message = await prisma.message.create({
    data: { chatId: chat.id, userId: ownerId, role: "USER", content: [{ type: "text", text: "see attached" }] },
  });
  const id = randomUUID();
  const attachment = await prisma.attachment.create({
    data: {
      id,
      userId: ownerId,
      chatId: chat.id,
      messageId: message.id,
      source: "UPLOAD",
      status: "READY",
      mimeType: "image/png",
      sizeBytes: BigInt(2048),
      url: TRANSLOADIT_URL,
      storageKey: opts.archived ? `uploads/${ownerId}/${id}.png` : null,
      sanitizedMetadata: { filename: "photo.png" },
      order: 0,
    },
  });
  await linkSentUploads(message.id);
  return { chat, message, attachment };
}

describe("attachment retrieval — archived attachments", () => {
  it("returns a short-lived signed B2 URL, signed for the authenticated owner with a one-hour TTL", async () => {
    const owner = await user("ret-archived");
    const { chat, attachment } = await messageWithAttachment(owner.id, { archived: true });

    const page = await listMessages(owner.id, chat.id, { limit: 10 });
    const url = new URL(page.items[0].attachments[0].url!);

    expect(mockSign).toHaveBeenCalledTimes(1);
    expect(mockSign).toHaveBeenCalledWith(attachment.storageKey, owner.id, 3600);
    expect(`${url.origin}${url.pathname}`).toBe(`${B2_ENDPOINT}/${B2_BUCKET}/${attachment.storageKey}`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("never returns the storageKey field, the raw Transloadit URL, or the B2 secret", async () => {
    const owner = await user("ret-no-leak");
    const { chat } = await messageWithAttachment(owner.id, { archived: true });
    const page = await listMessages(owner.id, chat.id, { limit: 10 });
    const attachment = page.items[0].attachments[0];
    expect(attachment).not.toHaveProperty("storageKey");
    const body = JSON.stringify(page);
    expect(body).not.toContain(TRANSLOADIT_URL);
    expect(body).not.toContain("r2.dev");
    expect(body).not.toContain(B2_SECRET);
  });

  it("returns a generic error when signing fails — no Transloadit fallback, no state change", async () => {
    const owner = await user("ret-sign-fail");
    const { chat, attachment } = await messageWithAttachment(owner.id, { archived: true });
    mockSign.mockRejectedValueOnce(new Error(`signing exploded for ${B2_SECRET} at ${B2_ENDPOINT}`));

    const err = await listMessages(owner.id, chat.id, { limit: 10 }).catch((e) => e);

    expect(err).toBeInstanceOf(AttachmentUrlUnavailableError);
    expect(err.message).toBe("This file is temporarily unavailable.");
    for (const leak of [B2_SECRET, B2_ENDPOINT, B2_BUCKET, TRANSLOADIT_URL, "uploads/"]) {
      expect(err.message).not.toContain(leak);
    }
    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: attachment.id } });
    expect(row).toEqual(attachment);
  });

  it("signs the archived URL on other attachment responses too (cancel path)", async () => {
    const owner = await user("ret-cancel");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const id = randomUUID();
    await prisma.attachment.create({
      data: {
        id,
        userId: owner.id,
        chatId: chat.id,
        source: "UPLOAD",
        status: "READY",
        mimeType: "image/png",
        url: TRANSLOADIT_URL,
        storageKey: `uploads/${owner.id}/${id}.png`,
        order: 0,
      },
    });
    const response = await cancelUpload(owner.id, id);
    expect(response.url?.startsWith(`${B2_ENDPOINT}/${B2_BUCKET}/uploads/${owner.id}/${id}.png?`)).toBe(true);
    expect(mockSign).toHaveBeenCalledWith(`uploads/${owner.id}/${id}.png`, owner.id, 3600);
  });
});

describe("attachment retrieval — legacy attachments (READY, never archived)", () => {
  it("keeps returning the existing Transloadit URL", async () => {
    const owner = await user("ret-legacy");
    const { chat } = await messageWithAttachment(owner.id, { archived: false });
    const page = await listMessages(owner.id, chat.id, { limit: 10 });
    expect(page.items[0].attachments[0].url).toBe(TRANSLOADIT_URL);
  });

  it("does not sign, copy to B2, or mutate the row during retrieval", async () => {
    const owner = await user("ret-legacy-readonly");
    const { chat, attachment } = await messageWithAttachment(owner.id, { archived: false });
    await listMessages(owner.id, chat.id, { limit: 10 });
    expect(mockSign).not.toHaveBeenCalled();
    expect(mockCopy).not.toHaveBeenCalled();
    expect(await prisma.attachment.findUniqueOrThrow({ where: { id: attachment.id } })).toEqual(attachment);
  });
});

describe("attachment retrieval — ownership", () => {
  it("returns the non-leaking 404 for another user's chat and never signs anything", async () => {
    const owner = await user("ret-owner");
    const intruder = await user("ret-intruder");
    const { chat } = await messageWithAttachment(owner.id, { archived: true });
    await expect(listMessages(intruder.id, chat.id, { limit: 10 })).rejects.toThrow(NotFoundError);
    expect(mockSign).not.toHaveBeenCalled();
  });

  it("refuses (generic error) if a key outside the owner's namespace is ever stored on their attachment", async () => {
    const owner = await user("ret-foreign-key");
    const other = await user("ret-foreign-key-other");
    const { chat, attachment } = await messageWithAttachment(owner.id, { archived: true });
    await prisma.attachment.update({ where: { id: attachment.id }, data: { storageKey: `uploads/${other.id}/${randomUUID()}.png` } });
    await expect(listMessages(owner.id, chat.id, { limit: 10 })).rejects.toThrow(AttachmentUrlUnavailableError);
  });
});
