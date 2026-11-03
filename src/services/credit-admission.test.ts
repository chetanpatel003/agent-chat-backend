import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

// Admission runs before any provider call. startMagicaRun is mocked to stop
// right after admission so a test can prove whether a run would have started.
vi.mock("@/providers/magica", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/providers/magica")>();
  return {
    ...actual,
    startMagicaRun: vi.fn(() => Promise.reject(new Error("STOP_AFTER_ADMISSION"))),
    getMagicaRun: vi.fn(() => Promise.reject(new Error("must not poll"))),
  };
});

import { startMagicaRun } from "@/providers/magica";
import { prisma } from "@/lib/prisma";
import { makeTestUser, cleanupTestUsers } from "@/test-utils/db-fixtures";
import { ToolExecutionError } from "@/tools/types";
import { cropImageTool, editImageTool, generateImageTool, mergeVideosTool, CROP_IMAGE_CREDITS } from "@/tools/magica-tools";

// Reserved .test host + fake key: a missed mock can never reach real Magica.
const MAGICA = "https://inference.magica.test";
const ESTIMATE_URL = `${MAGICA}/v1/nodes/estimate-credits`;

let estimateBodies: unknown[] = [];
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const ORIGINAL = { base: process.env.MAGICA_BASE_URL, key: process.env.MAGICA_API_KEY };
beforeEach(() => {
  process.env.MAGICA_BASE_URL = MAGICA;
  process.env.MAGICA_API_KEY = "test-magica-key";
  estimateBodies = [];
  vi.mocked(startMagicaRun).mockClear();
});

const createdUserIds: string[] = [];
afterAll(async () => {
  process.env.MAGICA_BASE_URL = ORIGINAL.base;
  process.env.MAGICA_API_KEY = ORIGINAL.key;
  await cleanupTestUsers(createdUserIds);
});

async function userWithBalance(label: string, balance: number | null) {
  const u = await makeTestUser(label);
  createdUserIds.push(u.id);
  if (balance !== null) await prisma.creditAccount.create({ data: { userId: u.id, balance: BigInt(balance) } });
  return u;
}

function serveEstimate(respond: () => Response) {
  server.use(
    http.post(ESTIMATE_URL, async ({ request }) => {
      estimateBodies.push(await request.json());
      return respond();
    }),
  );
}

const ctx = (userId: string) => ({ agentRunId: randomUUID(), userId, invocationId: randomUUID() });

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.catch((e) => e);
  return error instanceof ToolExecutionError ? error.code : (error as Error).message;
}

describe("crop_image — fixed estimate", () => {
  it("admits when the balance covers the fixed 5000 and starts the run", async () => {
    const u = await userWithBalance("adm-crop-ok", 5000);
    expect(await codeOf(cropImageTool.execute({ image_url: "https://x.example/a.png" }, ctx(u.id)))).toBe("STOP_AFTER_ADMISSION");
    expect(startMagicaRun).toHaveBeenCalledTimes(1);
    expect(CROP_IMAGE_CREDITS).toBe(BigInt(5000));
    expect(estimateBodies).toHaveLength(0);
  });

  it("refuses with INSUFFICIENT_CREDITS before any provider call", async () => {
    const u = await userWithBalance("adm-crop-low", 4999);
    expect(await codeOf(cropImageTool.execute({ image_url: "https://x.example/a.png" }, ctx(u.id)))).toBe("INSUFFICIENT_CREDITS");
    expect(startMagicaRun).not.toHaveBeenCalled();
  });

  it("treats a user with no credit account as a zero balance (no implicit grant)", async () => {
    const u = await userWithBalance("adm-crop-none", null);
    expect(await codeOf(cropImageTool.execute({ image_url: "https://x.example/a.png" }, ctx(u.id)))).toBe("INSUFFICIENT_CREDITS");
    expect(await prisma.creditAccount.count({ where: { userId: u.id } })).toBe(0);
  });
});

describe("GPT Image 2 — Magica estimate with an explicit size", () => {
  it("estimates via estimate-credits (not /pricing) and admits when covered", async () => {
    const u = await userWithBalance("adm-gpt-ok", 68_484);
    serveEstimate(() => HttpResponse.json({ estimates: [{ microcredits: 68_484 }] }));
    const input = { prompt: "a fox", quality: "Medium" as const, size: "1024x1024" as const };
    expect(await codeOf(generateImageTool.execute(input, ctx(u.id)))).toBe("STOP_AFTER_ADMISSION");
    expect(estimateBodies).toEqual([
      { nodes: [{ type: "gpt_image_2", subModelId: "gpt-image-2-text", data: { prompt: "a fox", size: "1024x1024", quality: "Medium" } }] },
    ]);
  });

  it("refuses when the estimate exceeds the balance", async () => {
    const u = await userWithBalance("adm-gpt-low", 68_483);
    serveEstimate(() => HttpResponse.json({ estimates: [{ microcredits: 68_484 }] }));
    expect(await codeOf(generateImageTool.execute({ prompt: "a fox", size: "1024x1024" }, ctx(u.id)))).toBe("INSUFFICIENT_CREDITS");
    expect(startMagicaRun).not.toHaveBeenCalled();
  });

  it("never sends media to the estimator for edit_image", async () => {
    const u = await userWithBalance("adm-edit", 1_000_000);
    serveEstimate(() => HttpResponse.json({ estimates: [{ microcredits: 68_484 }] }));
    await codeOf(
      editImageTool.execute({ prompt: "brighter", uploadedImages: ["https://x.example/a.png"], size: "1536x1024" }, ctx(u.id)),
    );
    const node = (estimateBodies[0] as { nodes: Array<{ subModelId: string; data: Record<string, unknown> }> }).nodes[0];
    expect(node.subModelId).toBe("gpt-image-2-edit");
    expect(node.data).not.toHaveProperty("uploadedImages");
  });

  it.each([
    ["HTTP 500", () => new HttpResponse(null, { status: 500 })],
    ["a network error", () => HttpResponse.error()],
    ["a malformed body", () => HttpResponse.json({ nonsense: true })],
    ["an empty estimates array", () => HttpResponse.json({ estimates: [] })],
    ["a negative estimate", () => HttpResponse.json({ estimates: [{ microcredits: -1 }] })],
    ["a fractional estimate", () => HttpResponse.json({ estimates: [{ microcredits: 1.5 }] })],
  ])("fails closed with CREDIT_ESTIMATE_UNAVAILABLE on %s", async (_label, respond) => {
    const u = await userWithBalance("adm-gpt-error", 1_000_000);
    serveEstimate(respond as () => Response);
    expect(await codeOf(generateImageTool.execute({ prompt: "x", size: "1024x1024" }, ctx(u.id)))).toBe("CREDIT_ESTIMATE_UNAVAILABLE");
    expect(startMagicaRun).not.toHaveBeenCalled();
  });
});

describe("unestimable cases — refused, never run silently", () => {
  it.each([
    ["size Auto", { prompt: "x", size: "Auto" as const }],
    ["size omitted (defaults to Auto)", { prompt: "x" }],
  ])("refuses GPT Image 2 with %s, without estimating or starting", async (_label, input) => {
    const u = await userWithBalance("adm-auto", 10_000_000);
    expect(await codeOf(generateImageTool.execute(input, ctx(u.id)))).toBe("EXPLICIT_SIZE_REQUIRED");
    expect(estimateBodies).toHaveLength(0);
    expect(startMagicaRun).not.toHaveBeenCalled();
  });

  it("refuses Merge Videos of external URLs (no measured duration), even with a large balance", async () => {
    // Decision 0018: merges are admitted only for the user's own uploads with a measured
    // duration (see merge-admission.test.ts for the full policy).
    const u = await userWithBalance("adm-merge", 10_000_000);
    const input = { video_urls: ["https://x.example/a.mp4", "https://x.example/b.mp4"] };
    expect(await codeOf(mergeVideosTool.execute(input, ctx(u.id)))).toBe("MERGE_SOURCE_UNSUPPORTED");
    expect(estimateBodies).toHaveLength(0);
    expect(startMagicaRun).not.toHaveBeenCalled();
  });
});
