import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

// Magica must never be called by archival: any call fails the test.
vi.mock("@/providers/magica", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/providers/magica")>();
  return {
    ...actual,
    startMagicaRun: vi.fn(() => Promise.reject(new Error("Magica must not be called"))),
    getMagicaRun: vi.fn(() => Promise.reject(new Error("Magica must not be called"))),
  };
});

import { startMagicaRun, getMagicaRun } from "@/providers/magica";
import { prisma } from "@/lib/prisma";
import { makeTestUser, cleanupTestUsers } from "@/test-utils/db-fixtures";
import { isAgentRunRecentlyActive } from "@/services/run-transitions";
import { archiveRunGeneratedAssets } from "@/services/generated-assets";
import {
  ARCHIVAL_RETRY,
  archivalIdempotencyKey,
  archiveGeneratedAssets,
  dispatchGeneratedAssetArchival,
  runGeneratedAssetArchival,
  TransientArchivalError,
} from "./archive-generated-assets";

// B2 = the fake .test endpoint forced by vitest.setup.ts; Magica output
// hosts are mocked; MSW errors on anything unhandled — no live traffic.
// Trigger.dev is mocked by spying on the task's `trigger`; Trigger.dev's
// retry engine is simulated by invoking the task body once per attempt.
const B2 = "https://s3.us-east-005.backblazeb2.test/agentChat";
const IMG_A = "https://g.tlcdn.com/gen/retry-a.png";
const IMG_B = "https://static.magica.com/retry-b.png";

let puts: string[] = [];
const server = setupServer(
  http.put(`${B2}/*`, async ({ request }) => {
    await request.arrayBuffer();
    puts.push(new URL(request.url).pathname);
    return new HttpResponse(null, { status: 200 });
  }),
  http.get(IMG_A, () => new HttpResponse(Buffer.alloc(32, 1), { headers: { "content-type": "image/png", "content-length": "32" } })),
  http.get(IMG_B, () => new HttpResponse(Buffer.alloc(32, 2), { headers: { "content-type": "image/png", "content-length": "32" } })),
);
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());
beforeEach(() => {
  puts = [];
  vi.mocked(startMagicaRun).mockClear();
  vi.mocked(getMagicaRun).mockClear();
});
afterEach(() => {
  expect(startMagicaRun).not.toHaveBeenCalled();
  expect(getMagicaRun).not.toHaveBeenCalled();
});

const createdUserIds: string[] = [];
afterAll(() => cleanupTestUsers(createdUserIds));

async function completedInvocation(label: string, urls: string[] | string = [IMG_A]) {
  const owner = await makeTestUser(label);
  createdUserIds.push(owner.id);
  const chat = await prisma.chat.create({ data: { userId: owner.id } });
  const run = await prisma.agentRun.create({
    data: { chatId: chat.id, userId: owner.id, idempotencyKey: randomUUID(), status: "RUNNING" },
  });
  const message = await prisma.message.create({
    data: { chatId: chat.id, userId: owner.id, agentRunId: run.id, role: "ASSISTANT", status: "PENDING", content: [] },
  });
  const output = { raw: { result: urls, provider: "fal" }, images: urls, creditUsed: 1 };
  const invocation = await prisma.toolInvocation.create({
    data: { agentRunId: run.id, messageId: message.id, toolName: "generate_image", idempotencyKey: randomUUID(), input: {}, output, status: "COMPLETED", providerRunId: `mr_${randomUUID()}` },
  });
  return { owner, chat, run, message, invocation };
}

const rows = (toolInvocationId: string) =>
  prisma.attachment.findMany({ where: { toolInvocationId }, orderBy: { order: "asc" } });

/** Simulates Trigger.dev's retry loop: re-runs the task body until it stops throwing. */
async function runWithRetries(toolInvocationId: string) {
  const errors: unknown[] = [];
  for (let attempt = 1; attempt <= ARCHIVAL_RETRY.maxAttempts; attempt++) {
    try {
      return { summary: await runGeneratedAssetArchival({ toolInvocationId }), attempts: attempt, errors };
    } catch (error) {
      errors.push(error);
    }
  }
  return { summary: null, attempts: ARCHIVAL_RETRY.maxAttempts, errors };
}

describe("archive-generated-assets task — retries", () => {
  it("retries a transient B2 failure and ends READY on a later attempt", async () => {
    const { invocation } = await completedInvocation("arch-transient");
    server.use(http.put(`${B2}/*`, () => new HttpResponse("<Error/>", { status: 503 }), { once: true }));

    const result = await runWithRetries(invocation.id);

    expect(result.attempts).toBe(2);
    expect(result.errors[0]).toBeInstanceOf(TransientArchivalError);
    expect(result.summary).toMatchObject({ outputs: 1, ready: 1, transientFailures: 0 });
    const [row] = await rows(invocation.id);
    expect(row.status).toBe("READY");
    expect(row.storageKey).toBe(`generated/${row.userId}/${invocation.id}-0.png`);
  });

  it("recovers a PROCESSING row stranded by a crash, reusing the same row and key", async () => {
    const { owner, chat, message, invocation } = await completedInvocation("arch-stranded");
    const stranded = await prisma.attachment.create({
      data: {
        userId: owner.id,
        chatId: chat.id,
        messageId: message.id,
        toolInvocationId: invocation.id,
        source: "GENERATED",
        status: "PROCESSING",
        mimeType: "application/octet-stream",
        order: 0,
      },
    });

    await runGeneratedAssetArchival({ toolInvocationId: invocation.id });

    const all = await rows(invocation.id);
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(stranded.id);
    expect(all[0].status).toBe("READY");
    expect(all[0].storageKey).toBe(`generated/${owner.id}/${invocation.id}-0.png`);
  });

  it("retries a FAILED row from an earlier attempt", async () => {
    const { invocation } = await completedInvocation("arch-failed-row");
    server.use(http.get(IMG_A, () => HttpResponse.error(), { once: true }));
    await expect(runGeneratedAssetArchival({ toolInvocationId: invocation.id })).rejects.toBeInstanceOf(TransientArchivalError);
    expect((await rows(invocation.id))[0].status).toBe("FAILED");

    await runGeneratedAssetArchival({ toolInvocationId: invocation.id });
    expect((await rows(invocation.id))[0].status).toBe("READY");
  });

  it("gives transient failures a bounded number of attempts, one copy attempt per try, on one row", async () => {
    expect(ARCHIVAL_RETRY).toEqual({ maxAttempts: 5, factor: 2, minTimeoutInMs: 2_000, maxTimeoutInMs: 60_000, randomize: true });
    const { invocation } = await completedInvocation("arch-bounded");
    server.use(http.put(`${B2}/*`, async ({ request }) => {
      await request.arrayBuffer();
      puts.push(new URL(request.url).pathname);
      return new HttpResponse("<Error/>", { status: 503 });
    }));

    const result = await runWithRetries(invocation.id);

    expect(result.summary).toBeNull();
    expect(result.errors).toHaveLength(ARCHIVAL_RETRY.maxAttempts);
    expect(result.errors.every((e) => e instanceof TransientArchivalError)).toBe(true);
    expect(puts).toHaveLength(ARCHIVAL_RETRY.maxAttempts);
    expect(new Set(puts).size).toBe(1);
    const all = await rows(invocation.id);
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe("FAILED");
  });

  it.each([
    ["a disallowed source host", ["https://evil.example/x.png"], undefined],
    ["an unsupported media type", [IMG_A], "audio/mpeg"],
  ])("does not retry a permanent failure: %s", async (_label, urls, contentType) => {
    const { invocation } = await completedInvocation("arch-permanent", urls);
    if (contentType) {
      server.use(http.get(IMG_A, () => new HttpResponse(Buffer.alloc(8), { headers: { "content-type": contentType, "content-length": "8" } })));
    }
    const summary = await runGeneratedAssetArchival({ toolInvocationId: invocation.id });
    expect(summary).toMatchObject({ outputs: 1, ready: 0, permanentFailures: 1, transientFailures: 0 });
    expect(puts).toHaveLength(0);
    expect((await rows(invocation.id))[0].status).toBe("FAILED");
  });

  it("does not retry malformed output (nothing to archive, no rows)", async () => {
    const { invocation } = await completedInvocation("arch-malformed", "not-an-array");
    const summary = await runGeneratedAssetArchival({ toolInvocationId: invocation.id });
    expect(summary).toEqual({ outputs: 0, ready: 0, permanentFailures: 0, transientFailures: 0 });
    expect(await rows(invocation.id)).toHaveLength(0);
  });

  it("rejects a malformed task payload", async () => {
    await expect(runGeneratedAssetArchival({ toolInvocationId: "nope" })).rejects.toThrow();
  });

  it("is not blocked by a recently active parent AgentRun", async () => {
    const { run, invocation } = await completedInvocation("arch-live-parent");
    await prisma.agentRun.update({ where: { id: run.id }, data: { turnCount: 1 } });
    expect(await isAgentRunRecentlyActive(run.id)).toBe(true);

    await runGeneratedAssetArchival({ toolInvocationId: invocation.id });
    expect((await rows(invocation.id))[0].status).toBe("READY");
  });

  it("produces one durable attachment per output under concurrent attempts", async () => {
    const { invocation } = await completedInvocation("arch-concurrent", [IMG_A, IMG_B]);
    await Promise.all([
      runGeneratedAssetArchival({ toolInvocationId: invocation.id }),
      runGeneratedAssetArchival({ toolInvocationId: invocation.id }),
    ]);
    const all = await rows(invocation.id);
    expect(all.map((r) => [r.order, r.status])).toEqual([
      [0, "READY"],
      [1, "READY"],
    ]);
  });

  it("leaves the Magica invocation COMPLETED, with its output untouched, when archival fails", async () => {
    const { invocation } = await completedInvocation("arch-outcome-preserved");
    server.use(http.put(`${B2}/*`, () => new HttpResponse("<Error/>", { status: 503 })));
    await runWithRetries(invocation.id);
    const after = await prisma.toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } });
    expect(after.status).toBe("COMPLETED");
    expect(after.errorCode).toBeNull();
    expect(after.errorMessage).toBeNull();
    expect(after.output).toEqual(invocation.output);
    expect(after.providerRunId).toBe(invocation.providerRunId);
  });
});

describe("archive-generated-assets task — dispatch", () => {
  it("dispatches with a deterministic per-invocation idempotency key, so repeats are the same job", async () => {
    const { invocation } = await completedInvocation("arch-dispatch");
    const trigger = vi.spyOn(archiveGeneratedAssets, "trigger").mockResolvedValue({ id: "run_fake" } as never);

    expect(await dispatchGeneratedAssetArchival(invocation.id)).toBe("dispatched");
    expect(await dispatchGeneratedAssetArchival(invocation.id)).toBe("dispatched");

    expect(trigger).toHaveBeenCalledTimes(2);
    for (const call of trigger.mock.calls) {
      expect(call[0]).toEqual({ toolInvocationId: invocation.id });
      expect(call[1]).toMatchObject({ idempotencyKey: archivalIdempotencyKey(invocation.id), idempotencyKeyTTL: "24h" });
    }
    expect(archivalIdempotencyKey(invocation.id)).toBe(`archive-generated-assets:${invocation.id}`);
  });

  it("repeated executions of the same job create no duplicate rows and no second copy", async () => {
    const { invocation } = await completedInvocation("arch-repeat");
    await runGeneratedAssetArchival({ toolInvocationId: invocation.id });
    await runGeneratedAssetArchival({ toolInvocationId: invocation.id });
    expect(await rows(invocation.id)).toHaveLength(1);
    expect(puts).toHaveLength(1);
  });

  it("logs a dispatch failure and archives inline instead of losing the job", async () => {
    const { invocation } = await completedInvocation("arch-dispatch-fail");
    vi.spyOn(archiveGeneratedAssets, "trigger").mockRejectedValue(new Error("Trigger.dev unavailable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await dispatchGeneratedAssetArchival(invocation.id)).toBe("inline");

    expect(log).toHaveBeenCalledWith(
      "Generated asset archival dispatch failed; archiving inline",
      expect.objectContaining({ toolInvocationId: invocation.id }),
    );
    expect((await rows(invocation.id))[0].status).toBe("READY");
  });

  it("leaves the output recoverable by the run-level sweep when dispatch and the inline attempt both fail", async () => {
    const { run, invocation } = await completedInvocation("arch-dispatch-and-inline-fail");
    vi.spyOn(archiveGeneratedAssets, "trigger").mockRejectedValue(new Error("Trigger.dev unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    server.use(http.put(`${B2}/*`, () => new HttpResponse("<Error/>", { status: 503 }), { once: true }));

    await dispatchGeneratedAssetArchival(invocation.id);
    expect((await rows(invocation.id))[0].status).toBe("FAILED");

    await archiveRunGeneratedAssets(run.id);
    expect((await rows(invocation.id))[0].status).toBe("READY");
  });
});
