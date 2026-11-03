import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { prisma } from "@/lib/prisma";
import { NotFoundError } from "@/lib/errors";
import { makeTestUser, cleanupTestUsers, linkSentUploads } from "@/test-utils/db-fixtures";
import { buildConversationContext } from "@/providers/conversation-context";
import { listMessages } from "./message";
import { archiveInvocationOutputs, archiveRunGeneratedAssets, extractGeneratedOutputs } from "./generated-assets";

// B2 is the fake .test endpoint forced by vitest.setup.ts; Magica output
// hosts are mocked with MSW, which errors on any unhandled request — so no
// live B2 or Magica traffic is possible, and no Magica *run* is ever
// requested (no handler exists for inference.magica.com).
const B2 = "https://s3.us-east-005.backblazeb2.test/agentChat";
const IMG_A = "https://g.tlcdn.com/gen/aaaa.png";
const IMG_B = "https://static.magica.com/bbbb.png";
const VIDEO = "https://static.magica.com/merged.mp4";

let puts: { path: string; contentType: string | null; bytes: number }[] = [];
const server = setupServer(
  http.put(`${B2}/*`, async ({ request }) => {
    puts.push({
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
beforeEach(() => {
  puts = [];
});

function serveMedia(url: string, contentType: string, size = 64) {
  let fetches = 0;
  server.use(
    http.get(url, () => {
      fetches++;
      return new HttpResponse(Buffer.alloc(size, 9), {
        headers: { "content-type": contentType, "content-length": String(size) },
      });
    }),
  );
  return () => fetches;
}

const createdUserIds: string[] = [];
afterAll(() => cleanupTestUsers(createdUserIds));

async function user(label: string) {
  const u = await makeTestUser(label);
  createdUserIds.push(u.id);
  return u;
}

/** A COMPLETED Magica invocation on an assistant message, as the agent loop persists it. */
async function completedInvocation(ownerId: string, toolName: string, output: unknown) {
  const chat = await prisma.chat.create({ data: { userId: ownerId } });
  const run = await prisma.agentRun.create({
    data: { chatId: chat.id, userId: ownerId, idempotencyKey: randomUUID(), status: "RUNNING" },
  });
  const message = await prisma.message.create({
    data: { chatId: chat.id, userId: ownerId, agentRunId: run.id, role: "ASSISTANT", status: "COMPLETE", content: [{ type: "text", text: "Here you go." }] },
  });
  const invocation = await prisma.toolInvocation.create({
    data: {
      agentRunId: run.id,
      messageId: message.id,
      toolName,
      idempotencyKey: randomUUID(),
      input: {},
      output: output as object,
      status: "COMPLETED",
    },
  });
  return { chat, run, message, invocation };
}

const generateOutput = (urls: string[]) => ({
  raw: {
    result: urls,
    provider: "fal",
    creditUsed: 8385,
    resultMetadata: urls.map((_, i) => ({ width: 1024 + i, height: 768, mimeType: "image/png", mediaType: "image" })),
  },
  images: urls,
  creditUsed: 8385,
});

const rowsOf = (toolInvocationId: string) =>
  prisma.attachment.findMany({ where: { toolInvocationId }, orderBy: { order: "asc" } });

describe("extractGeneratedOutputs — evidence-based, tool-specific", () => {
  it("reads generate_image/edit_image from images[] or raw.result[] (live-verified shape)", () => {
    expect(extractGeneratedOutputs("generate_image", generateOutput([IMG_A]))).toEqual({ family: "image", urls: [IMG_A] });
    expect(extractGeneratedOutputs("edit_image", { raw: { result: [IMG_B] } })).toEqual({ family: "image", urls: [IMG_B] });
  });

  it("reads crop_image image_url and merge_videos video_url (assessment-documented)", () => {
    expect(extractGeneratedOutputs("crop_image", { raw: { image_url: IMG_A } })).toEqual({ family: "image", urls: [IMG_A] });
    expect(extractGeneratedOutputs("merge_videos", { raw: { video_url: VIDEO } })).toEqual({ family: "video", urls: [VIDEO] });
  });

  it.each([
    ["generate_image", null],
    ["generate_image", { raw: { result: "not-an-array" } }],
    ["generate_image", { raw: { result: [42] } }],
    ["crop_image", { raw: { image_url: 5 } }],
    ["merge_videos", { raw: {} }],
    ["load_skill", generateOutput([IMG_A])],
  ])("returns nothing for %s with malformed/unknown output", (tool, output) => {
    expect(extractGeneratedOutputs(tool, output)).toBeNull();
  });
});

describe("archiveInvocationOutputs", () => {
  it("archives an image into B2 and records a READY GENERATED attachment with correct associations", async () => {
    const owner = await user("gen-image");
    const { chat, message, invocation } = await completedInvocation(owner.id, "generate_image", generateOutput([IMG_A]));
    serveMedia(IMG_A, "image/png", 128);

    await archiveInvocationOutputs(invocation.id);

    const [row] = await rowsOf(invocation.id);
    const key = `generated/${owner.id}/${invocation.id}-0.png`;
    expect(row).toMatchObject({
      userId: owner.id,
      chatId: chat.id,
      messageId: message.id,
      toolInvocationId: invocation.id,
      source: "GENERATED",
      status: "READY",
      mimeType: "image/png",
      sizeBytes: BigInt(128),
      storageKey: key,
      url: null,
      sanitizedMetadata: { width: 1024, height: 768 },
      order: 0,
    });
    expect(puts).toEqual([{ path: `/agentChat/${key}`, contentType: "image/png", bytes: 128 }]);
    expect((await prisma.toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } })).status).toBe("COMPLETED");
  });

  it("archives a merge_videos output as video", async () => {
    const owner = await user("gen-video");
    const { invocation } = await completedInvocation(owner.id, "merge_videos", { raw: { video_url: VIDEO } });
    serveMedia(VIDEO, "video/mp4", 4096);
    await archiveInvocationOutputs(invocation.id);
    const [row] = await rowsOf(invocation.id);
    expect(row).toMatchObject({ status: "READY", mimeType: "video/mp4", storageKey: `generated/${owner.id}/${invocation.id}-0.mp4` });
  });

  it("derives type and extension from the fetched response, not the URL", async () => {
    const owner = await user("gen-mime");
    const { invocation } = await completedInvocation(owner.id, "generate_image", generateOutput([IMG_A]));
    serveMedia(IMG_A, "image/jpeg; charset=binary");
    await archiveInvocationOutputs(invocation.id);
    const [row] = await rowsOf(invocation.id);
    expect(row.mimeType).toBe("image/jpeg");
    expect(row.storageKey).toBe(`generated/${owner.id}/${invocation.id}-0.jpg`);
  });

  it("rejects a media type the tool cannot produce (e.g. audio from an image tool) without a READY row", async () => {
    const owner = await user("gen-wrong-type");
    const { invocation } = await completedInvocation(owner.id, "generate_image", generateOutput([IMG_A]));
    serveMedia(IMG_A, "audio/mpeg");
    await archiveInvocationOutputs(invocation.id);
    const [row] = await rowsOf(invocation.id);
    expect(row.status).toBe("FAILED");
    expect(row.storageKey).toBeNull();
    expect(puts).toHaveLength(0);
  });

  it("preserves the provider's output order across multiple outputs", async () => {
    const owner = await user("gen-order");
    const { invocation } = await completedInvocation(owner.id, "generate_image", generateOutput([IMG_A, IMG_B]));
    serveMedia(IMG_A, "image/png");
    serveMedia(IMG_B, "image/webp");
    await archiveInvocationOutputs(invocation.id);
    const rows = await rowsOf(invocation.id);
    expect(rows.map((r) => [r.order, r.mimeType, r.storageKey])).toEqual([
      [0, "image/png", `generated/${owner.id}/${invocation.id}-0.png`],
      [1, "image/webp", `generated/${owner.id}/${invocation.id}-1.webp`],
    ]);
  });

  it("does not create a READY attachment when the B2 copy fails, and recovers on a later attempt", async () => {
    const owner = await user("gen-b2-fail");
    const { invocation } = await completedInvocation(owner.id, "generate_image", generateOutput([IMG_A]));
    serveMedia(IMG_A, "image/png");
    server.use(http.put(`${B2}/*`, () => new HttpResponse("<Error/>", { status: 500 }), { once: true }));

    await archiveInvocationOutputs(invocation.id);
    let [row] = await rowsOf(invocation.id);
    expect(row.status).toBe("FAILED");
    expect(row.storageKey).toBeNull();

    await archiveInvocationOutputs(invocation.id);
    [row] = await rowsOf(invocation.id);
    expect(row.status).toBe("READY");
    expect(await prisma.attachment.count({ where: { toolInvocationId: invocation.id } })).toBe(1);
  });

  it("retries safely after the copy succeeded but the database write failed (same key, one row)", async () => {
    const owner = await user("gen-db-fail");
    const { invocation } = await completedInvocation(owner.id, "generate_image", generateOutput([IMG_A]));
    serveMedia(IMG_A, "image/png");
    const spy = vi.spyOn(prisma.attachment, "updateMany").mockRejectedValueOnce(new Error("connection reset"));

    await archiveInvocationOutputs(invocation.id);
    spy.mockRestore();
    let [row] = await rowsOf(invocation.id);
    expect(row.status).not.toBe("READY");
    expect(row.storageKey).toBeNull();
    expect(puts).toHaveLength(1);

    await archiveInvocationOutputs(invocation.id);
    [row] = await rowsOf(invocation.id);
    expect(row.status).toBe("READY");
    expect(puts.map((p) => p.path)).toEqual([puts[0].path, puts[0].path]);
    expect(await prisma.attachment.count({ where: { toolInvocationId: invocation.id } })).toBe(1);
  });

  it("is idempotent: a repeated archive makes no duplicate rows and no second copy", async () => {
    const owner = await user("gen-dup");
    const { invocation } = await completedInvocation(owner.id, "generate_image", generateOutput([IMG_A]));
    const fetches = serveMedia(IMG_A, "image/png");
    await archiveInvocationOutputs(invocation.id);
    await archiveInvocationOutputs(invocation.id);
    expect(await prisma.attachment.count({ where: { toolInvocationId: invocation.id } })).toBe(1);
    expect(puts).toHaveLength(1);
    expect(fetches()).toBe(1);
  });

  it("settles concurrent archivers on one durable READY row per output", async () => {
    const owner = await user("gen-race");
    const { invocation } = await completedInvocation(owner.id, "generate_image", generateOutput([IMG_A, IMG_B]));
    serveMedia(IMG_A, "image/png");
    serveMedia(IMG_B, "image/png");
    await Promise.all([archiveInvocationOutputs(invocation.id), archiveInvocationOutputs(invocation.id)]);
    const rows = await rowsOf(invocation.id);
    expect(rows.map((r) => [r.order, r.status])).toEqual([
      [0, "READY"],
      [1, "READY"],
    ]);
    expect(new Set(rows.map((r) => r.storageKey)).size).toBe(2);
  });

  it("handles an expired provider URL safely: FAILED row, tool outcome untouched", async () => {
    const owner = await user("gen-expired");
    const { invocation } = await completedInvocation(owner.id, "generate_image", generateOutput([IMG_A]));
    server.use(http.get(IMG_A, () => new HttpResponse(null, { status: 404 })));
    await archiveInvocationOutputs(invocation.id);
    const [row] = await rowsOf(invocation.id);
    expect(row.status).toBe("FAILED");
    expect(puts).toHaveLength(0);
    const inv = await prisma.toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } });
    expect(inv.status).toBe("COMPLETED");
    expect(inv.errorCode).toBeNull();
  });

  it("creates no attachment for malformed output, an unknown tool, or a non-COMPLETED invocation", async () => {
    const owner = await user("gen-malformed");
    const malformed = await completedInvocation(owner.id, "generate_image", { raw: { result: "nope" } });
    const unknownTool = await completedInvocation(owner.id, "load_skill", generateOutput([IMG_A]));
    const running = await completedInvocation(owner.id, "generate_image", generateOutput([IMG_A]));
    await prisma.toolInvocation.update({ where: { id: running.invocation.id }, data: { status: "RUNNING" } });
    for (const { invocation } of [malformed, unknownTool, running]) await archiveInvocationOutputs(invocation.id);
    expect(await prisma.attachment.count({ where: { userId: owner.id } })).toBe(0);
  });

  it("refuses sources outside the verified host allowlist", async () => {
    const owner = await user("gen-host");
    const { invocation } = await completedInvocation(owner.id, "generate_image", generateOutput(["https://evil.example/x.png"]));
    await archiveInvocationOutputs(invocation.id);
    const [row] = await rowsOf(invocation.id);
    expect(row.status).toBe("FAILED");
    expect(puts).toHaveLength(0);
  });
});

describe("archiveRunGeneratedAssets — recovery", () => {
  it("archives from the stored output only: no Magica run is requested, and repeat recovery is a no-op", async () => {
    const owner = await user("gen-recovery");
    const { run, invocation } = await completedInvocation(owner.id, "generate_image", generateOutput([IMG_A]));
    serveMedia(IMG_A, "image/png");
    // No handler for inference.magica.com: any Magica request would fail the test (onUnhandledFrame: error).
    await archiveRunGeneratedAssets(run.id);
    await archiveRunGeneratedAssets(run.id);
    const rows = await rowsOf(invocation.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("READY");
    expect(puts).toHaveLength(1);
  });
});

describe("generated asset retrieval and context", () => {
  it("serves archived generated assets through signed B2 URLs on the assistant message", async () => {
    const owner = await user("gen-retrieval");
    const { chat, invocation } = await completedInvocation(owner.id, "generate_image", generateOutput([IMG_A]));
    serveMedia(IMG_A, "image/png");
    await archiveInvocationOutputs(invocation.id);

    const page = await listMessages(owner.id, chat.id, { limit: 10 });
    const [attachment] = page.items[0].attachments;
    expect(attachment.source).toBe("GENERATED");
    expect(attachment.url?.startsWith(`${B2}/generated/${owner.id}/${invocation.id}-0.png?`)).toBe(true);
    expect(attachment).not.toHaveProperty("storageKey");
    expect(JSON.stringify(page)).not.toContain(IMG_A);
  });

  it("exposes no URL for a generated asset that is not archived yet", async () => {
    const owner = await user("gen-not-ready");
    const { chat, invocation } = await completedInvocation(owner.id, "generate_image", generateOutput([IMG_A]));
    server.use(http.get(IMG_A, () => new HttpResponse(null, { status: 404 })));
    await archiveInvocationOutputs(invocation.id);
    const page = await listMessages(owner.id, chat.id, { limit: 10 });
    expect(page.items[0].attachments[0]).toMatchObject({ status: "FAILED", url: null });
  });

  it("keeps cross-user access denied", async () => {
    const owner = await user("gen-owner");
    const intruder = await user("gen-intruder");
    const { chat, invocation } = await completedInvocation(owner.id, "generate_image", generateOutput([IMG_A]));
    serveMedia(IMG_A, "image/png");
    await archiveInvocationOutputs(invocation.id);
    await expect(listMessages(intruder.id, chat.id, { limit: 10 })).rejects.toThrow(NotFoundError);
  });

  it("gives the model durable signed URLs for archived generated and uploaded files, never provider/Transloadit URLs", async () => {
    const owner = await user("gen-context");
    const { chat, invocation } = await completedInvocation(owner.id, "generate_image", generateOutput([IMG_A]));
    serveMedia(IMG_A, "image/png");
    await archiveInvocationOutputs(invocation.id);
    const userMessage = await prisma.message.create({
      data: { chatId: chat.id, userId: owner.id, role: "USER", status: "COMPLETE", content: [{ type: "text", text: "crop it" }] },
    });
    const uploadId = randomUUID();
    await prisma.attachment.create({
      data: {
        id: uploadId,
        userId: owner.id,
        chatId: chat.id,
        messageId: userMessage.id,
        source: "UPLOAD",
        status: "READY",
        mimeType: "image/png",
        url: "https://pub-e8fef8c0e03b44acb340577811800829.r2.dev/tmp/u.png",
        storageKey: `uploads/${owner.id}/${uploadId}.png`,
        order: 0,
      },
    });
    await linkSentUploads(userMessage.id);

    const context = await buildConversationContext(chat.id, owner.id);
    const assistant = context.find((m) => m.role === "assistant")!;
    const userTurn = context.find((m) => m.role === "user")!;
    expect(assistant.content).toMatch(
      new RegExp(`Generated files \\(in order\\):\\n1\\. image/png ${B2}/generated/${owner.id}/${invocation.id}-0\\.png\\?X-Amz-`),
    );
    expect(userTurn.content).toMatch(new RegExp(`Attached files \\(in order\\):\\n1\\. image/png ${B2}/uploads/${owner.id}/${uploadId}\\.png\\?`));
    const all = JSON.stringify(context);
    expect(all).not.toContain(IMG_A);
    expect(all).not.toContain("r2.dev");
    expect(all).toContain("X-Amz-Expires=3600");
  });
});
