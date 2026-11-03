import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { prisma } from "@/lib/prisma";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { makeTestUser, cleanupTestUsers } from "@/test-utils/db-fixtures";
import { CreateAttachmentRequestSchema, MAX_IMAGE_UPLOAD_BYTES } from "@/contracts/attachment";
import {
  attachToMessage,
  authorizeUpload,
  listMediaLibrary,
  cancelUpload,
  completeUpload,
  createAttachment,
  ATTACHMENT_USABLE_FOR_MS,
  UploadArchiveError,
  UploadStorageUnavailableError,
} from "./attachment";

// Real Transloadit temporary-storage host (on the B2 copy allowlist).
const PNG_URL = "https://pub-e8fef8c0e03b44acb340577811800829.r2.dev/abc/photo.png";
const PNG_BYTES = Buffer.alloc(2048, 1);
// Reserved .test host: no request can ever reach real B2.
const B2_ENDPOINT = "https://s3.us-east-005.backblazeb2.test";
const B2_BUCKET = "agentChat";
const B2_SECRET = "K005FAKEAPPLICATIONKEYSECRETVAL";

let b2Puts: { path: string; contentType: string | null; bytes: number }[] = [];
let sourceFetches = 0;

const server = setupServer(
  http.get(PNG_URL, () => {
    sourceFetches++;
    return new HttpResponse(PNG_BYTES, {
      headers: { "content-type": "image/png", "content-length": String(PNG_BYTES.length) },
    });
  }),
  http.put(`${B2_ENDPOINT}/${B2_BUCKET}/*`, async ({ request }) => {
    b2Puts.push({
      path: new URL(request.url).pathname,
      contentType: request.headers.get("content-type"),
      bytes: (await request.arrayBuffer()).byteLength,
    });
    return new HttpResponse(null, { status: 200 });
  }),
);
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const ENV_KEYS = [
  "TRANSLOADIT_KEY",
  "TRANSLOADIT_SECRET",
  "B2_KEY_ID",
  "B2_APPLICATION_KEY",
  "B2_BUCKET_NAME",
  "B2_ENDPOINT",
  "B2_REGION",
] as const;
const ORIGINAL = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
beforeEach(() => {
  process.env.TRANSLOADIT_KEY = "test-key";
  process.env.TRANSLOADIT_SECRET = "test-secret";
  process.env.B2_KEY_ID = "0050000000000000000000001";
  process.env.B2_APPLICATION_KEY = B2_SECRET;
  process.env.B2_BUCKET_NAME = B2_BUCKET;
  process.env.B2_ENDPOINT = B2_ENDPOINT;
  process.env.B2_REGION = "us-east-005";
  b2Puts = [];
  sourceFetches = 0;
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

const assemblyId = () => randomBytes(16).toString("hex");

function serveAssembly(id: string, body: Record<string, unknown>) {
  let calls = 0;
  server.use(
    http.get(`https://api2.transloadit.com/assemblies/${id}`, () => {
      calls++;
      return HttpResponse.json({ assembly_id: id, ...body });
    }),
  );
  return () => calls;
}

function completedBody(nonce: string, upload: Record<string, unknown> = {}) {
  return {
    ok: "ASSEMBLY_COMPLETED",
    params: JSON.stringify({ auth: { key: "****" }, nonce }),
    uploads: [{ mime: "image/png", size: 2048, ssl_url: PNG_URL, meta: { width: 640, height: 480 }, ...upload }],
  };
}

async function authorized(ownerId: string, chatId?: string, mimeType: "image/png" | "video/mp4" = "image/png") {
  const att = await createAttachment(ownerId, { chatId, filename: "photo.png", mimeType, sizeBytes: 1000 });
  const auth = await authorizeUpload(ownerId, att.id);
  return { att, nonce: JSON.parse(auth.params).nonce as string, auth };
}

async function ready(ownerId: string, chatId?: string) {
  const { att, nonce } = await authorized(ownerId, chatId);
  const id = assemblyId();
  serveAssembly(id, completedBody(nonce));
  return completeUpload(ownerId, att.id, id);
}

describe("createAttachment", () => {
  it("persists a PENDING upload owned by the caller", async () => {
    const owner = await user("att-create");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const att = await createAttachment(owner.id, { chatId: chat.id, filename: "a.png", mimeType: "image/png", sizeBytes: 10 });
    expect(att).toMatchObject({ status: "PENDING", source: "UPLOAD", mimeType: "image/png", url: null, metadata: { filename: "a.png" } });
    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: att.id } });
    expect(row.userId).toBe(owner.id);
    expect(row.chatId).toBe(chat.id);
  });

  it("rejects attaching to another user's chat with a 404", async () => {
    const owner = await user("att-create-owner");
    const intruder = await user("att-create-intruder");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    await expect(
      createAttachment(intruder.id, { chatId: chat.id, filename: "a.png", mimeType: "image/png", sizeBytes: 10 }),
    ).rejects.toThrow(NotFoundError);
  });

  it("validates type and size before anything is created", () => {
    expect(CreateAttachmentRequestSchema.safeParse({ filename: "a.gif", mimeType: "image/gif", sizeBytes: 1 }).success).toBe(false);
    expect(
      CreateAttachmentRequestSchema.safeParse({ filename: "a.png", mimeType: "image/png", sizeBytes: MAX_IMAGE_UPLOAD_BYTES + 1 }).success,
    ).toBe(false);
    expect(CreateAttachmentRequestSchema.safeParse({ filename: "v.mp4", mimeType: "video/mp4", sizeBytes: 50_000_000 }).success).toBe(true);
  });
});

describe("authorizeUpload", () => {
  it("returns signed params whose nonce is bound to this attachment, and marks it UPLOADING", async () => {
    const owner = await user("att-auth");
    const { att, nonce, auth } = await authorized(owner.id);
    expect(nonce.startsWith(`${att.id}:`)).toBe(true);
    expect(auth.signature).toMatch(/^sha384:[a-f0-9]{96}$/);
    expect(JSON.stringify(auth)).not.toContain("test-secret");
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: att.id } })).status).toBe("UPLOADING");
  });

  it("issues a fresh nonce on retry", async () => {
    const owner = await user("att-auth-retry");
    const { att, nonce } = await authorized(owner.id);
    const again = JSON.parse((await authorizeUpload(owner.id, att.id)).params).nonce;
    expect(again).not.toBe(nonce);
  });

  it("hides another user's attachment as not found", async () => {
    const owner = await user("att-auth-owner");
    const intruder = await user("att-auth-intruder");
    const { att } = await authorized(owner.id);
    await expect(authorizeUpload(intruder.id, att.id)).rejects.toThrow(NotFoundError);
  });

  it("refuses to re-authorize a finished upload", async () => {
    const owner = await user("att-auth-ready");
    const att = await ready(owner.id);
    await expect(authorizeUpload(owner.id, att.id)).rejects.toThrow(ConflictError);
  });
});

describe("completeUpload", () => {
  it("marks READY using server-verified type, size, URL and dimensions — not the client's declared values", async () => {
    const owner = await user("att-complete");
    const { att, nonce } = await authorized(owner.id);
    const id = assemblyId();
    serveAssembly(id, completedBody(nonce, { size: 4096 }));
    const result = await completeUpload(owner.id, att.id, id);
    expect(result).toMatchObject({
      status: "READY",
      mimeType: "image/png",
      sizeBytes: 4096,
      metadata: { filename: "photo.png", width: 640, height: 480 },
    });
    // Archived, so the response carries a signed B2 URL; the verified
    // Transloadit URL stays in the row only.
    expect(result.url?.startsWith(`${B2_ENDPOINT}/${B2_BUCKET}/uploads/${owner.id}/${att.id}.png?`)).toBe(true);
    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: att.id } });
    expect(row.assemblyId).toBe(id);
    expect(row.url).toBe(PNG_URL);
  });

  it("is idempotent: a duplicate completion returns the READY attachment without re-fetching", async () => {
    const owner = await user("att-complete-dup");
    const { att, nonce } = await authorized(owner.id);
    const id = assemblyId();
    const calls = serveAssembly(id, completedBody(nonce));
    const first = await completeUpload(owner.id, att.id, id);
    const second = await completeUpload(owner.id, att.id, id);
    // Each response is freshly signed, so compare all but the signature.
    expect({ ...second, url: second.url?.split("?")[0] }).toEqual({ ...first, url: first.url?.split("?")[0] });
    expect(calls()).toBe(1);
  });

  it("handles concurrent duplicate completions without error", async () => {
    const owner = await user("att-complete-race");
    const { att, nonce } = await authorized(owner.id);
    const id = assemblyId();
    serveAssembly(id, completedBody(nonce));
    const results = await Promise.all([completeUpload(owner.id, att.id, id), completeUpload(owner.id, att.id, id)]);
    expect(results.map((r) => r.status)).toEqual(["READY", "READY"]);
  });

  it("rejects an Assembly created for a different attachment (nonce mismatch) and marks FAILED", async () => {
    const owner = await user("att-complete-nonce");
    const { att } = await authorized(owner.id);
    const other = await authorized(owner.id);
    const id = assemblyId();
    serveAssembly(id, completedBody(other.nonce));
    await expect(completeUpload(owner.id, att.id, id)).rejects.toThrow(ValidationError);
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: att.id } })).status).toBe("FAILED");
  });

  it("rejects an unsupported server-detected type even if the client declared an image", async () => {
    const owner = await user("att-complete-mime");
    const { att, nonce } = await authorized(owner.id);
    const id = assemblyId();
    serveAssembly(id, completedBody(nonce, { mime: "application/x-msdownload" }));
    await expect(completeUpload(owner.id, att.id, id)).rejects.toThrow(/not supported/);
  });

  it("rejects an oversized upload measured by Transloadit", async () => {
    const owner = await user("att-complete-size");
    const { att, nonce } = await authorized(owner.id);
    const id = assemblyId();
    serveAssembly(id, completedBody(nonce, { size: MAX_IMAGE_UPLOAD_BYTES + 1 }));
    await expect(completeUpload(owner.id, att.id, id)).rejects.toThrow(/too large/);
  });

  it("rejects a non-https result URL", async () => {
    const owner = await user("att-complete-url");
    const { att, nonce } = await authorized(owner.id);
    const id = assemblyId();
    serveAssembly(id, completedBody(nonce, { ssl_url: "http://insecure.example/a.png" }));
    await expect(completeUpload(owner.id, att.id, id)).rejects.toThrow(/valid URL/);
  });

  it("marks FAILED when the Assembly reports an error or the response is malformed", async () => {
    const owner = await user("att-complete-error");
    const a = await authorized(owner.id);
    const errId = assemblyId();
    serveAssembly(errId, { error: "INVALID_FILE", params: JSON.stringify({ nonce: a.nonce }) });
    await expect(completeUpload(owner.id, a.att.id, errId)).rejects.toThrow(ValidationError);

    const b = await authorized(owner.id);
    const badId = assemblyId();
    server.use(http.get(`https://api2.transloadit.com/assemblies/${badId}`, () => HttpResponse.json({ garbage: 1 })));
    await expect(completeUpload(owner.id, b.att.id, badId)).rejects.toThrow(ValidationError);
    const statuses = await prisma.attachment.findMany({ where: { id: { in: [a.att.id, b.att.id] } } });
    expect(statuses.map((s) => s.status)).toEqual(["FAILED", "FAILED"]);
  });

  it("does not change state while the Assembly is still running", async () => {
    const owner = await user("att-complete-running");
    const { att, nonce } = await authorized(owner.id);
    const id = assemblyId();
    serveAssembly(id, { ok: "ASSEMBLY_EXECUTING", params: JSON.stringify({ nonce }) });
    await expect(completeUpload(owner.id, att.id, id)).rejects.toThrow(ConflictError);
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: att.id } })).status).toBe("UPLOADING");
  });

  it("allows a retried upload to complete after an earlier failure", async () => {
    const owner = await user("att-complete-retry");
    const { att, nonce } = await authorized(owner.id);
    const failedId = assemblyId();
    serveAssembly(failedId, { error: "UPLOAD_FAILED", params: JSON.stringify({ nonce }) });
    await expect(completeUpload(owner.id, att.id, failedId)).rejects.toThrow();
    const retryNonce = JSON.parse((await authorizeUpload(owner.id, att.id)).params).nonce;
    const okId = assemblyId();
    serveAssembly(okId, completedBody(retryNonce));
    expect((await completeUpload(owner.id, att.id, okId)).status).toBe("READY");
  });

  it("hides another user's attachment as not found, without contacting Transloadit", async () => {
    const owner = await user("att-complete-owner");
    const intruder = await user("att-complete-intruder");
    const { att, nonce } = await authorized(owner.id);
    const id = assemblyId();
    const calls = serveAssembly(id, completedBody(nonce));
    await expect(completeUpload(intruder.id, att.id, id)).rejects.toThrow(NotFoundError);
    expect(calls()).toBe(0);
  });
});

describe("completeUpload — B2 archival", () => {
  const rowOf = (id: string) => prisma.attachment.findUniqueOrThrow({ where: { id } });

  it("streams the verified file to uploads/{userId}/{attachmentId}.{ext} and persists the key with READY", async () => {
    const owner = await user("att-b2-ok");
    const { att, nonce } = await authorized(owner.id);
    const id = assemblyId();
    serveAssembly(id, completedBody(nonce));

    const result = await completeUpload(owner.id, att.id, id);

    const key = `uploads/${owner.id}/${att.id}.png`;
    expect(result.status).toBe("READY");
    expect(b2Puts).toEqual([{ path: `/${B2_BUCKET}/${key}`, contentType: "image/png", bytes: PNG_BYTES.length }]);
    expect((await rowOf(att.id)).storageKey).toBe(key);
    expect(result).not.toHaveProperty("storageKey");
  });

  it("derives the extension from the server-verified type, not the client filename or declaration", async () => {
    const owner = await user("att-b2-ext");
    const att = await createAttachment(owner.id, { filename: "evil.exe.png", mimeType: "image/png", sizeBytes: 10 });
    const nonce = JSON.parse((await authorizeUpload(owner.id, att.id)).params).nonce;
    const id = assemblyId();
    serveAssembly(id, completedBody(nonce, { mime: "image/jpeg" }));
    await completeUpload(owner.id, att.id, id);
    expect((await rowOf(att.id)).storageKey).toBe(`uploads/${owner.id}/${att.id}.jpg`);
  });

  it("keeps the attachment non-READY with a generic retriable error when B2 fails, then succeeds on retry", async () => {
    const owner = await user("att-b2-fail");
    const { att, nonce } = await authorized(owner.id);
    const id = assemblyId();
    serveAssembly(id, completedBody(nonce));
    server.use(http.put(`${B2_ENDPOINT}/${B2_BUCKET}/*`, () => new HttpResponse("<Error/>", { status: 503 }), { once: true }));

    const err = await completeUpload(owner.id, att.id, id).catch((e) => e);
    expect(err).toBeInstanceOf(UploadArchiveError);
    expect(err.message).toBe("The uploaded file could not be stored. Please retry.");
    expect(err.message).not.toContain(B2_SECRET);
    const failedRow = await rowOf(att.id);
    expect(failedRow.status).toBe("UPLOADING");
    expect(failedRow.storageKey).toBeNull();

    const retried = await completeUpload(owner.id, att.id, id);
    expect(retried.status).toBe("READY");
    expect((await rowOf(att.id)).storageKey).toBe(`uploads/${owner.id}/${att.id}.png`);
  });

  it("recovers when the copy succeeded but the database write failed: the retry overwrites the same key", async () => {
    const owner = await user("att-b2-dbfail");
    const { att, nonce } = await authorized(owner.id);
    const id = assemblyId();
    serveAssembly(id, completedBody(nonce));
    const spy = vi.spyOn(prisma.attachment, "updateMany").mockRejectedValueOnce(new Error("connection reset"));

    await expect(completeUpload(owner.id, att.id, id)).rejects.toThrow("connection reset");
    spy.mockRestore();
    expect(b2Puts).toHaveLength(1);
    const afterCrash = await rowOf(att.id);
    expect(afterCrash.status).toBe("UPLOADING");
    expect(afterCrash.storageKey).toBeNull();

    expect((await completeUpload(owner.id, att.id, id)).status).toBe("READY");
    expect(b2Puts).toHaveLength(2);
    expect(b2Puts[1].path).toBe(b2Puts[0].path);
    expect(await prisma.attachment.count({ where: { userId: owner.id } })).toBe(1);
  });

  it("does not copy again, or re-read Transloadit, once READY with a storage key", async () => {
    const owner = await user("att-b2-dup");
    const { att, nonce } = await authorized(owner.id);
    const id = assemblyId();
    const statusCalls = serveAssembly(id, completedBody(nonce));
    const first = await completeUpload(owner.id, att.id, id);
    const second = await completeUpload(owner.id, att.id, id);
    // Each response is freshly signed, so compare all but the signature.
    expect({ ...second, url: second.url?.split("?")[0] }).toEqual({ ...first, url: first.url?.split("?")[0] });
    expect(b2Puts).toHaveLength(1);
    expect(statusCalls()).toBe(1);
    expect(await prisma.attachment.count({ where: { userId: owner.id } })).toBe(1);
  });

  it("settles concurrent completions on one READY row with one key", async () => {
    const owner = await user("att-b2-race");
    const { att, nonce } = await authorized(owner.id);
    const id = assemblyId();
    serveAssembly(id, completedBody(nonce));
    const results = await Promise.all([completeUpload(owner.id, att.id, id), completeUpload(owner.id, att.id, id)]);
    expect(results.map((r) => r.status)).toEqual(["READY", "READY"]);
    expect(new Set(b2Puts.map((p) => p.path)).size).toBe(1);
    expect((await rowOf(att.id)).storageKey).toBe(`uploads/${owner.id}/${att.id}.png`);
  });

  it("never touches Transloadit or B2 for another user's attachment", async () => {
    const owner = await user("att-b2-owner");
    const intruder = await user("att-b2-intruder");
    const { att, nonce } = await authorized(owner.id);
    const id = assemblyId();
    const statusCalls = serveAssembly(id, completedBody(nonce));
    await expect(completeUpload(intruder.id, att.id, id)).rejects.toThrow(NotFoundError);
    expect(statusCalls()).toBe(0);
    expect(sourceFetches).toBe(0);
    expect(b2Puts).toHaveLength(0);
  });

  it("refuses to archive from a host outside the verified allowlist, leaving the attachment retriable", async () => {
    const owner = await user("att-b2-host");
    const { att, nonce } = await authorized(owner.id);
    const id = assemblyId();
    serveAssembly(id, completedBody(nonce, { ssl_url: "https://evil.example/photo.png" }));
    await expect(completeUpload(owner.id, att.id, id)).rejects.toThrow(UploadArchiveError);
    expect(b2Puts).toHaveLength(0);
    expect((await rowOf(att.id)).status).toBe("UPLOADING");
  });

  it("reports storage as unavailable (503-mapped) without fetching the file when B2 is unconfigured", async () => {
    const owner = await user("att-b2-config");
    const { att, nonce } = await authorized(owner.id);
    const id = assemblyId();
    serveAssembly(id, completedBody(nonce));
    delete process.env.B2_APPLICATION_KEY;
    const err = await completeUpload(owner.id, att.id, id).catch((e) => e);
    expect(err).toBeInstanceOf(UploadStorageUnavailableError);
    expect(err.message).not.toContain("B2_");
    expect(sourceFetches).toBe(0);
    expect((await rowOf(att.id)).status).toBe("UPLOADING");
  });

  describe("READY uploads verified before archiving existed (option a)", () => {
    async function legacyReady(ownerId: string, url = PNG_URL) {
      return prisma.attachment.create({
        data: { userId: ownerId, source: "UPLOAD", status: "READY", mimeType: "image/png", sizeBytes: BigInt(2048), url, order: 0 },
      });
    }

    it("archives on the next completion call", async () => {
      const owner = await user("att-b2-legacy");
      const row = await legacyReady(owner.id);
      const result = await completeUpload(owner.id, row.id, assemblyId());
      expect(result.status).toBe("READY");
      expect((await rowOf(row.id)).storageKey).toBe(`uploads/${owner.id}/${row.id}.png`);
      expect(b2Puts).toHaveLength(1);
    });

    it("surfaces the error and leaves the row READY without a key when the temporary file has expired", async () => {
      const owner = await user("att-b2-legacy-expired");
      const expiredUrl = "https://pub-e8fef8c0e03b44acb340577811800829.r2.dev/gone/photo.png";
      server.use(http.get(expiredUrl, () => new HttpResponse(null, { status: 404 })));
      const row = await legacyReady(owner.id, expiredUrl);
      await expect(completeUpload(owner.id, row.id, assemblyId())).rejects.toThrow(UploadArchiveError);
      const after = await rowOf(row.id);
      expect(after.status).toBe("READY");
      expect(after.storageKey).toBeNull();
    });
  });
});

describe("cancelUpload", () => {
  it("marks CANCELLED, and a later completion is refused", async () => {
    const owner = await user("att-cancel");
    const { att, nonce } = await authorized(owner.id);
    expect((await cancelUpload(owner.id, att.id)).status).toBe("CANCELLED");
    const id = assemblyId();
    serveAssembly(id, completedBody(nonce));
    await expect(completeUpload(owner.id, att.id, id)).rejects.toThrow(ConflictError);
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: att.id } })).status).toBe("CANCELLED");
  });

  it("refuses to cancel another user's attachment", async () => {
    const owner = await user("att-cancel-owner");
    const intruder = await user("att-cancel-intruder");
    const { att } = await authorized(owner.id);
    await expect(cancelUpload(intruder.id, att.id)).rejects.toThrow(NotFoundError);
  });
});

describe("attachToMessage", () => {
  async function messageIn(ownerId: string, chatId: string) {
    return prisma.message.create({
      data: { chatId, userId: ownerId, role: "USER", status: "COMPLETE", content: [{ type: "text", text: "hi" }] },
    });
  }

  it("binds READY uploads to the message in the requested order", async () => {
    const owner = await user("att-bind");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const first = await ready(owner.id, chat.id);
    const second = await ready(owner.id);
    const message = await messageIn(owner.id, chat.id);
    await prisma.$transaction((tx) => attachToMessage(tx, owner.id, chat.id, message.id, [second.id, first.id]));
    const rows = await prisma.attachment.findMany({ where: { messageId: message.id }, orderBy: { order: "asc" } });
    expect(rows.map((r) => [r.id, r.order, r.chatId])).toEqual([
      [second.id, 0, chat.id],
      [first.id, 1, chat.id],
    ]);
  });

  it.each(["PENDING", "UPLOADING", "FAILED", "CANCELLED", "EXPIRED"] as const)(
    "refuses a %s attachment",
    async (status) => {
      const owner = await user(`att-bind-${status}`);
      const chat = await prisma.chat.create({ data: { userId: owner.id } });
      const att = await createAttachment(owner.id, { filename: "a.png", mimeType: "image/png", sizeBytes: 1 });
      await prisma.attachment.update({ where: { id: att.id }, data: { status } });
      const message = await messageIn(owner.id, chat.id);
      await expect(
        prisma.$transaction((tx) => attachToMessage(tx, owner.id, chat.id, message.id, [att.id])),
      ).rejects.toThrow(ValidationError);
    },
  );

  it("treats another user's attachment as not found", async () => {
    const owner = await user("att-bind-owner");
    const intruder = await user("att-bind-intruder");
    const theirs = await ready(owner.id);
    const chat = await prisma.chat.create({ data: { userId: intruder.id } });
    const message = await messageIn(intruder.id, chat.id);
    await expect(
      prisma.$transaction((tx) => attachToMessage(tx, intruder.id, chat.id, message.id, [theirs.id])),
    ).rejects.toThrow(NotFoundError);
  });

  it("refuses an attachment uploaded for a different chat", async () => {
    const owner = await user("att-bind-crosschat");
    const chatA = await prisma.chat.create({ data: { userId: owner.id } });
    const chatB = await prisma.chat.create({ data: { userId: owner.id } });
    const att = await ready(owner.id, chatA.id);
    const message = await messageIn(owner.id, chatB.id);
    await expect(
      prisma.$transaction((tx) => attachToMessage(tx, owner.id, chatB.id, message.id, [att.id])),
    ).rejects.toThrow(/different chat/);
  });

  it("records the send order in MessageAttachment as well", async () => {
    const owner = await user("att-bind-join");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const a = await ready(owner.id, chat.id);
    const b = await ready(owner.id, chat.id);
    const message = await messageIn(owner.id, chat.id);
    await prisma.$transaction((tx) => attachToMessage(tx, owner.id, chat.id, message.id, [b.id, a.id]));
    const links = await prisma.messageAttachment.findMany({ where: { messageId: message.id }, orderBy: { order: "asc" } });
    expect(links.map((l) => [l.attachmentId, l.order])).toEqual([
      [b.id, 0],
      [a.id, 1],
    ]);
  });

  it("a sent upload without a permanent copy can't be sent again", async () => {
    const owner = await user("att-bind-twice-unarchived");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const att = await ready(owner.id, chat.id);
    await prisma.attachment.update({ where: { id: att.id }, data: { storageKey: null } });
    const m1 = await messageIn(owner.id, chat.id);
    const m2 = await messageIn(owner.id, chat.id);
    await prisma.$transaction((tx) => attachToMessage(tx, owner.id, chat.id, m1.id, [att.id]));
    await expect(
      prisma.$transaction((tx) => attachToMessage(tx, owner.id, chat.id, m2.id, [att.id])),
    ).rejects.toThrow(/no longer available/);
    expect(await prisma.messageAttachment.count({ where: { messageId: m2.id } })).toBe(0);
  });

  it("refuses an upload older than the temporary-storage window", async () => {
    const owner = await user("att-bind-expired");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const att = await ready(owner.id, chat.id);
    const message = await messageIn(owner.id, chat.id);
    const later = new Date(Date.now() + ATTACHMENT_USABLE_FOR_MS + 60_000);
    await expect(
      prisma.$transaction((tx) => attachToMessage(tx, owner.id, chat.id, message.id, [att.id], later)),
    ).rejects.toThrow(/expired/);
  });
});

describe("media library", () => {
  async function messageIn(ownerId: string, chatId: string) {
    return prisma.message.create({
      data: { chatId, userId: ownerId, role: "USER", status: "COMPLETE", content: [{ type: "text", text: "hi" }] },
    });
  }

  /** An archived upload already sent with a message in `chatId`. */
  async function sentUpload(ownerId: string, chatId: string) {
    const att = await ready(ownerId, chatId);
    const message = await messageIn(ownerId, chatId);
    await prisma.$transaction((tx) => attachToMessage(tx, ownerId, chatId, message.id, [att.id]));
    return att;
  }

  /** A generated, archived output of an assistant message in `chatId`. */
  async function generatedAsset(
    ownerId: string,
    chatId: string,
    storageKey: string | null = `generated/${ownerId}/${crypto.randomUUID()}.png`,
  ) {
    const message = await prisma.message.create({
      data: { chatId, userId: ownerId, role: "ASSISTANT", status: "COMPLETE", content: [] },
    });
    return prisma.attachment.create({
      data: {
        userId: ownerId,
        chatId,
        messageId: message.id,
        source: "GENERATED",
        status: "READY",
        mimeType: "image/png",
        url: "https://cdn.example.test/out.png",
        storageKey,
        order: 0,
      },
    });
  }

  it("re-sends a library item by its existing id: no new attachment row, origin unchanged, separate association", async () => {
    const owner = await user("lib-resend");
    const chatA = await prisma.chat.create({ data: { userId: owner.id } });
    const chatB = await prisma.chat.create({ data: { userId: owner.id } });
    const att = await sentUpload(owner.id, chatA.id);
    const origin = await prisma.attachment.findUniqueOrThrow({ where: { id: att.id } });
    const before = await prisma.attachment.count({ where: { userId: owner.id } });

    const message = await messageIn(owner.id, chatB.id);
    await prisma.$transaction((tx) => attachToMessage(tx, owner.id, chatB.id, message.id, [att.id]));

    expect(await prisma.attachment.count({ where: { userId: owner.id } })).toBe(before);
    const after = await prisma.attachment.findUniqueOrThrow({ where: { id: att.id } });
    expect([after.messageId, after.chatId, after.order]).toEqual([origin.messageId, origin.chatId, origin.order]);
    expect(await prisma.messageAttachment.findMany({ where: { attachmentId: att.id } })).toHaveLength(2);
  });

  it("mixes direct uploads and library picks in exactly the requested order (generated outputs included)", async () => {
    const owner = await user("lib-mixed-order");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const library = await sentUpload(owner.id, chat.id);
    const generated = await generatedAsset(owner.id, chat.id);
    const fresh = await ready(owner.id, chat.id);
    const message = await messageIn(owner.id, chat.id);
    await prisma.$transaction((tx) =>
      attachToMessage(tx, owner.id, chat.id, message.id, [generated.id, fresh.id, library.id]),
    );
    const links = await prisma.messageAttachment.findMany({ where: { messageId: message.id }, orderBy: { order: "asc" } });
    expect(links.map((l) => l.attachmentId)).toEqual([generated.id, fresh.id, library.id]);
    // The fresh upload's first send set its origin; the library items kept theirs.
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: fresh.id } })).messageId).toBe(message.id);
  });

  it("refuses a duplicate id in one send, and never creates a duplicate association", async () => {
    const owner = await user("lib-duplicate");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const att = await sentUpload(owner.id, chat.id);
    const message = await messageIn(owner.id, chat.id);
    await expect(
      prisma.$transaction((tx) => attachToMessage(tx, owner.id, chat.id, message.id, [att.id, att.id])),
    ).rejects.toThrow(ValidationError);
    await prisma.$transaction((tx) => attachToMessage(tx, owner.id, chat.id, message.id, [att.id]));
    await expect(
      prisma.$transaction((tx) => attachToMessage(tx, owner.id, chat.id, message.id, [att.id])),
    ).rejects.toThrow(); // primary key (messageId, attachmentId)
    expect(await prisma.messageAttachment.count({ where: { messageId: message.id } })).toBe(1);
  });

  it("treats another user's library item as not found", async () => {
    const owner = await user("lib-owner");
    const intruder = await user("lib-intruder");
    const ownerChat = await prisma.chat.create({ data: { userId: owner.id } });
    const theirs = await sentUpload(owner.id, ownerChat.id);
    const chat = await prisma.chat.create({ data: { userId: intruder.id } });
    const message = await messageIn(intruder.id, chat.id);
    await expect(
      prisma.$transaction((tx) => attachToMessage(tx, intruder.id, chat.id, message.id, [theirs.id])),
    ).rejects.toThrow(NotFoundError);
    expect((await listMediaLibrary(intruder.id, { limit: 50 })).items.map((i) => i.id)).not.toContain(theirs.id);
  });

  it("refuses unavailable media: not archived, from a deleted chat, or no longer READY", async () => {
    const owner = await user("lib-unavailable");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const unarchived = await generatedAsset(owner.id, chat.id, null);
    const expired = await generatedAsset(owner.id, chat.id);
    await prisma.attachment.update({ where: { id: expired.id }, data: { status: "EXPIRED" } });
    const deletedChat = await prisma.chat.create({ data: { userId: owner.id } });
    const fromDeleted = await sentUpload(owner.id, deletedChat.id);
    await prisma.chat.update({ where: { id: deletedChat.id }, data: { isDeleted: true } });

    const message = await messageIn(owner.id, chat.id);
    for (const id of [unarchived.id, expired.id, fromDeleted.id]) {
      await expect(
        prisma.$transaction((tx) => attachToMessage(tx, owner.id, chat.id, message.id, [id])),
      ).rejects.toThrow(/no longer available|finished uploads/);
    }
    const listed = (await listMediaLibrary(owner.id, { limit: 50 })).items.map((i) => i.id);
    expect(listed).not.toContain(unarchived.id);
    expect(listed).not.toContain(expired.id);
    expect(listed).not.toContain(fromDeleted.id);
  });

  it("lists sent uploads and generated outputs newest first, cursor-paginated, never unsent uploads", async () => {
    const owner = await user("lib-list");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const a = await sentUpload(owner.id, chat.id);
    const b = await generatedAsset(owner.id, chat.id);
    const c = await sentUpload(owner.id, chat.id);
    const unsent = await ready(owner.id, chat.id);

    const first = await listMediaLibrary(owner.id, { limit: 2 });
    expect(first.items.map((i) => i.id)).toEqual([c.id, b.id]);
    expect(first.hasMore).toBe(true);
    const second = await listMediaLibrary(owner.id, { limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.items.map((i) => i.id)).toEqual([a.id]);
    expect(second.hasMore).toBe(false);
    expect([...first.items, ...second.items].map((i) => i.id)).not.toContain(unsent.id);
    // Delivered as signed B2 URLs, never the stored key or a provider URL.
    expect(first.items[0].url?.startsWith(`${B2_ENDPOINT}/${B2_BUCKET}/`)).toBe(true);
    expect(JSON.stringify(first)).not.toContain("storageKey");
  });

  it("an item whose URL can't be signed is listed as unavailable (url null) instead of failing the page", async () => {
    const owner = await user("lib-unsignable");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const good = await generatedAsset(owner.id, chat.id);
    // A key outside the owner's namespace can never be signed for them.
    const bad = await generatedAsset(owner.id, chat.id, `generated/${crypto.randomUUID()}/${crypto.randomUUID()}.png`);
    const page = await listMediaLibrary(owner.id, { limit: 10 });
    const byId = new Map(page.items.map((i) => [i.id, i]));
    expect(byId.get(bad.id)?.url).toBeNull();
    expect(byId.get(good.id)?.url).toMatch(/^https:/);
  });

  it("an empty library is an empty page; an invalid cursor is a validation error", async () => {
    const owner = await user("lib-empty");
    expect(await listMediaLibrary(owner.id, { limit: 20 })).toEqual({ items: [], nextCursor: null, hasMore: false });
    await expect(listMediaLibrary(owner.id, { limit: 20, cursor: "not-a-cursor" })).rejects.toThrow(ValidationError);
  });
});
