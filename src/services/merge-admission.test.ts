import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

// Mocked providers: no Magica or OpenRouter request is ever made.
vi.mock("@/providers/openrouter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/providers/openrouter")>();
  return { ...actual, callOpenRouter: vi.fn() };
});
vi.mock("@/providers/magica", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/providers/magica")>();
  return { ...actual, startMagicaRun: vi.fn(), getMagicaRun: vi.fn(), estimateNodeCredits: vi.fn() };
});
// Never dispatch real Trigger.dev tasks (inline settlement still runs for real).
vi.mock("@/trigger/settle-tool-credits", () => ({ dispatchCreditSettlement: vi.fn().mockResolvedValue(true) }));
vi.mock("@/trigger/archive-generated-assets", () => ({ dispatchGeneratedAssetArchival: vi.fn().mockResolvedValue("dispatched") }));
vi.mock("@/services/generated-assets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/generated-assets")>();
  return { ...actual, archiveInvocationOutputs: vi.fn().mockResolvedValue(undefined), archiveRunGeneratedAssets: vi.fn().mockResolvedValue(undefined) };
});

import { callOpenRouter, type ProviderToolCall } from "@/providers/openrouter";
import { startMagicaRun, getMagicaRun, estimateNodeCredits } from "@/providers/magica";
import { prisma } from "@/lib/prisma";
import { makeTestUser, cleanupTestUsers } from "@/test-utils/db-fixtures";
import { ToolExecutionError } from "@/tools/types";
import { createToolRegistry } from "@/tools/registry";
import { mergeVideosTool, cropImageTool, CROP_IMAGE_CREDITS } from "@/tools/magica-tools";
import { executeAgentTurn, type TurnRuntime } from "@/trigger/run-agent-turn";
import { mergeAdmissionCredits, mergeRatePerMinute, resolveMergeSources, MERGE_MAX_TOTAL_SECONDS } from "./merge-admission";

const ENDPOINT = "https://s3.us-east-005.backblazeb2.test";
const BUCKET = "mergeTestBucket";
const ORIGINAL_ENV = { endpoint: process.env.B2_ENDPOINT, bucket: process.env.B2_BUCKET_NAME };
beforeAll(() => {
  process.env.B2_ENDPOINT = ENDPOINT;
  process.env.B2_BUCKET_NAME = BUCKET;
});
const createdUserIds: string[] = [];
afterAll(async () => {
  process.env.B2_ENDPOINT = ORIGINAL_ENV.endpoint;
  process.env.B2_BUCKET_NAME = ORIGINAL_ENV.bucket;
  await cleanupTestUsers(createdUserIds);
});
beforeEach(() => {
  vi.mocked(startMagicaRun).mockReset();
  vi.mocked(getMagicaRun).mockReset();
  vi.mocked(callOpenRouter).mockReset();
  vi.mocked(estimateNodeCredits).mockReset();
});

async function user(label: string, balance: number | null = null) {
  const u = await makeTestUser(label);
  createdUserIds.push(u.id);
  if (balance !== null) await prisma.creditAccount.create({ data: { userId: u.id, balance: BigInt(balance) } });
  return u;
}

/** A stored video attachment, as completeUpload/archival would write it. */
async function video(
  userId: string,
  opts: { seconds?: unknown; source?: "UPLOAD" | "GENERATED"; status?: "READY" | "UPLOADING" | "FAILED"; mimeType?: string; archived?: boolean } = {},
) {
  const id = randomUUID();
  const archived = opts.archived ?? true;
  const ext = (opts.mimeType ?? "video/mp4").startsWith("image/") ? "png" : "mp4";
  const key = `${opts.source === "GENERATED" ? "generated" : "uploads"}/${userId}/${id}.${ext}`;
  await prisma.attachment.create({
    data: {
      id,
      userId,
      source: opts.source ?? "UPLOAD",
      status: opts.status ?? "READY",
      mimeType: opts.mimeType ?? "video/mp4",
      sizeBytes: BigInt(1000),
      url: archived ? null : `https://tmp.transloadit.test/${id}.mp4`,
      storageKey: archived ? key : null,
      order: 0,
      sanitizedMetadata: opts.seconds === undefined ? {} : { durationSeconds: opts.seconds },
    },
  });
  // What the model is given (and passes back): a signed path-style B2 URL, or the Transloadit URL.
  return archived
    ? `${ENDPOINT}/${BUCKET}/${key}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=FAKE&X-Amz-Signature=deadbeef`
    : `https://tmp.transloadit.test/${id}.mp4`;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.catch((e) => e);
  return error instanceof ToolExecutionError ? error.code : String((error as Error)?.message ?? error);
}

describe("merge pricing formula (exact integers)", () => {
  it("rate(n) = 40,000 + 10,000 × (n − 1) per minute", () => {
    expect(mergeRatePerMinute(2)).toBe(50_000);
    expect(mergeRatePerMinute(3)).toBe(60_000);
    expect(mergeRatePerMinute(100)).toBe(1_030_000);
  });

  it("base = ceil(rate × S / 60) prorated (never whole minutes); required = ceil(base × 1.3)", () => {
    // 2 videos, 10 s: 50,000 × 10 / 60 = 8,333.33 → 8,334; × 1.3 = 10,834.2 → 10,835
    expect(mergeAdmissionCredits(2, 10)).toEqual({ base: BigInt(8_334), required: BigInt(10_835) });
    // exact minute: 2 videos, 60 s → 50,000; × 1.3 = 65,000 exactly
    expect(mergeAdmissionCredits(2, 60)).toEqual({ base: BigInt(50_000), required: BigInt(65_000) });
    // 3 videos, 61 s → ceil(60,000 × 61 / 60) = 61,000 (not 120,000 for 2 whole minutes); × 1.3 = 79,300
    expect(mergeAdmissionCredits(3, 61)).toEqual({ base: BigInt(61_000), required: BigInt(79_300) });
    // the cap: 2 videos, 300 s → 250,000; × 1.3 = 325,000
    expect(mergeAdmissionCredits(2, MERGE_MAX_TOTAL_SECONDS)).toEqual({ base: BigInt(250_000), required: BigInt(325_000) });
    // 100 videos, 300 s → 5,150,000; × 1.3 = 6,695,000
    expect(mergeAdmissionCredits(100, 300).required).toBe(BigInt(6_695_000));
  });

  it("is conservative against float noise and fractional seconds", () => {
    expect(mergeAdmissionCredits(2, 0.6).base).toBe(BigInt(500)); // 0.6 s × 50,000/60 = 500 exactly, not 501
    expect(mergeAdmissionCredits(2, 3.04).base).toBe(BigInt(2_534)); // 2,533.33 → 2,534
    expect(mergeAdmissionCredits(2, 0.001).required).toBe(BigInt(2)); // 0.83 → 1; × 1.3 → 2
  });
});

describe("resolveMergeSources — eligible inputs only", () => {
  it("sums the server-measured durations of the user's own READY uploads, in order", async () => {
    const u = await user("merge-ok");
    const a = await video(u.id, { seconds: 3 });
    const b = await video(u.id, { seconds: 4.5 });
    expect(await resolveMergeSources(u.id, [a, b])).toEqual({ videoCount: 2, totalSeconds: 7.5 });
  });

  it("accepts a not-yet-archived upload by its exact stored Transloadit URL", async () => {
    const u = await user("merge-unarchived");
    const a = await video(u.id, { seconds: 2, archived: false });
    const b = await video(u.id, { seconds: 2 });
    expect(await resolveMergeSources(u.id, [a, b])).toEqual({ videoCount: 2, totalSeconds: 4 });
  });

  it("counts duplicate URLs as separate inputs", async () => {
    const u = await user("merge-dupes");
    const a = await video(u.id, { seconds: 5 });
    expect(await resolveMergeSources(u.id, [a, a, a])).toEqual({ videoCount: 3, totalSeconds: 15 });
  });

  it("accepts exactly 300 seconds and rejects anything above", async () => {
    const u = await user("merge-cap");
    const a = await video(u.id, { seconds: 150 });
    const b = await video(u.id, { seconds: 150 });
    const c = await video(u.id, { seconds: 150.001 });
    expect(await resolveMergeSources(u.id, [a, b])).toEqual({ videoCount: 2, totalSeconds: 300 });
    expect(await codeOf(resolveMergeSources(u.id, [a, c]))).toBe("MERGE_DURATION_LIMIT");
  });

  it.each([
    ["missing", undefined],
    ["zero", 0],
    ["negative", -3],
    ["not a number", "3"],
  ])("rejects a %s duration as MERGE_DURATION_UNKNOWN", async (_label, seconds) => {
    const u = await user("merge-bad-duration");
    const good = await video(u.id, { seconds: 3 });
    const bad = await video(u.id, { seconds });
    expect(await codeOf(resolveMergeSources(u.id, [good, bad]))).toBe("MERGE_DURATION_UNKNOWN");
  });

  it("rejects external URLs, generated videos, other users' videos, non-READY uploads and non-videos as MERGE_SOURCE_UNSUPPORTED", async () => {
    const u = await user("merge-unsupported");
    const other = await user("merge-other-user");
    const good = await video(u.id, { seconds: 3 });
    const cases = {
      external: "https://cdn.example.com/clip.mp4",
      magicaOutput: "https://static.magica.com/merged.mp4",
      generated: await video(u.id, { seconds: 3, source: "GENERATED" }),
      otherUsers: await video(other.id, { seconds: 3 }),
      uploading: await video(u.id, { seconds: 3, status: "UPLOADING" }),
      failed: await video(u.id, { seconds: 3, status: "FAILED" }),
      image: await video(u.id, { seconds: 3, mimeType: "image/png" }),
      wrongBucket: good.replace(`/${BUCKET}/`, "/someOtherBucket/"),
      unknownTransloadit: "https://tmp.transloadit.test/not-ours.mp4",
    };
    for (const [label, url] of Object.entries(cases)) {
      expect([label, await codeOf(resolveMergeSources(u.id, [good, url]))]).toEqual([label, "MERGE_SOURCE_UNSUPPORTED"]);
    }
  });

  it("never trusts a client-supplied duration (only the stored, server-measured value counts)", async () => {
    const u = await user("merge-client-duration");
    const a = await video(u.id, { seconds: 200 });
    const b = await video(u.id, { seconds: 200 });
    // A URL can't carry a duration that changes anything: same rows, same 400 s → over the cap.
    expect(await codeOf(resolveMergeSources(u.id, [`${a}&duration=1`, b]))).toBe("MERGE_DURATION_LIMIT");
  });
});

describe("merge_videos admission through execute()", () => {
  const ctx = (userId: string) => ({ agentRunId: randomUUID(), userId, invocationId: randomUUID() });

  it("refuses with INSUFFICIENT_CREDITS before any provider call", async () => {
    const u = await user("merge-poor", 10_834); // needs 10,835 for 2 videos × 10 s
    const a = await video(u.id, { seconds: 4 });
    const b = await video(u.id, { seconds: 6 });
    expect(await codeOf(mergeVideosTool.execute({ video_urls: [a, b] }, ctx(u.id)))).toBe("INSUFFICIENT_CREDITS");
    expect(startMagicaRun).not.toHaveBeenCalled();
    expect(estimateNodeCredits).not.toHaveBeenCalled(); // no provider estimate needed or used
  });

  it("an eligible merge with enough balance proceeds to the provider exactly once", async () => {
    const u = await user("merge-admitted", 10_835);
    const a = await video(u.id, { seconds: 4 });
    const b = await video(u.id, { seconds: 6 });
    vi.mocked(startMagicaRun).mockRejectedValueOnce(new Error("STOP_AFTER_ADMISSION"));
    expect(await codeOf(mergeVideosTool.execute({ video_urls: [a, b] }, ctx(u.id)))).toBe("STOP_AFTER_ADMISSION");
    expect(startMagicaRun).toHaveBeenCalledTimes(1);
    expect(startMagicaRun).toHaveBeenCalledWith("merge_videos", { video_urls: [a, b] }, undefined);
  });

  it("image tools' admission is unchanged (crop still needs its fixed 5,000)", async () => {
    const u = await user("merge-crop-unchanged", Number(CROP_IMAGE_CREDITS) - 1);
    expect(await codeOf(cropImageTool.execute({ image_url: "https://x.example/a.png" }, ctx(u.id)))).toBe("INSUFFICIENT_CREDITS");
    expect(startMagicaRun).not.toHaveBeenCalled();
  });
});

// Full agent turns + inline settlement against the remote database: same budget as the
// end-to-end Magica tool tests in magica-tools.test.ts (AGENT_LOOP_WITH_SETTLEMENT_TIMEOUT_MS).
const AGENT_LOOP_WITH_SETTLEMENT_TIMEOUT_MS = 40_000;

describe("merge_videos end to end (agent and direct paths): settlement uses actual usage", { timeout: AGENT_LOOP_WITH_SETTLEMENT_TIMEOUT_MS }, () => {
  const runtime: TurnRuntime = {
    openTextStream: () => ({ write: () => {}, close: async () => {} }),
    waitpoints: { createToken: () => Promise.reject(new Error("unused")), forToken: () => Promise.reject(new Error("unused")) },
    webhooks: async () => {},
  };
  async function queuedRun(userId: string) {
    const chat = await prisma.chat.create({ data: { userId } });
    const run = await prisma.agentRun.create({ data: { chatId: chat.id, userId, idempotencyKey: randomUUID(), status: "QUEUED" } });
    await prisma.message.create({
      data: { chatId: chat.id, userId, agentRunId: run.id, role: "USER", status: "COMPLETE", content: [{ type: "text", text: "merge" }] },
    });
    return run;
  }
  const toolCall = (args: Record<string, unknown>): ProviderToolCall => ({ id: randomUUID(), type: "function", function: { name: "merge_videos", arguments: JSON.stringify(args) } });
  const completed = (creditUsed: number) => ({
    id: "magica_merge",
    nodeType: "merge_videos",
    status: "COMPLETED",
    createdAt: "2026-01-01T00:00:00Z",
    output: { result: ["https://static.magica.com/merged.mp4"] },
    creditUsed,
  });

  it("agent path: admitted, started once, charged Magica's reported creditUsed (not the 10,835 estimate)", async () => {
    const u = await user("merge-e2e-agent", 1_000_000);
    const a = await video(u.id, { seconds: 4 });
    const b = await video(u.id, { seconds: 6 });
    const run = await queuedRun(u.id);
    vi.mocked(callOpenRouter)
      .mockResolvedValueOnce({ model: "x/y:free", text: null, toolCalls: [toolCall({ video_urls: [a, b] })], promptTokens: 1, completionTokens: 1 })
      .mockResolvedValueOnce({ model: "x/y:free", text: "Merged.", toolCalls: null, promptTokens: 1, completionTokens: 1 });
    vi.mocked(startMagicaRun).mockResolvedValueOnce({ runId: "magica_merge_agent" });
    vi.mocked(getMagicaRun).mockResolvedValueOnce(completed(7_777) as never);

    const result = await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([mergeVideosTool]), () => {}, undefined, runtime);
    expect(result.status).toBe("COMPLETED");
    expect(startMagicaRun).toHaveBeenCalledTimes(1);
    const invocation = await prisma.toolInvocation.findFirstOrThrow({ where: { agentRunId: run.id } });
    expect({ used: invocation.creditsUsed, charged: invocation.creditsCharged }).toEqual({ used: BigInt(7_777), charged: BigInt(7_777) });
    const ledger = await prisma.creditLedger.findMany({ where: { userId: u.id, type: "TOOL_CHARGE" } });
    expect(ledger.map((l) => l.amount)).toEqual([BigInt(-7_777)]);
    expect((await prisma.creditAccount.findUniqueOrThrow({ where: { userId: u.id } })).balance).toBe(BigInt(1_000_000 - 7_777));
  });

  it("direct tool-run path applies the same admission: an ineligible source is refused, the provider never called", async () => {
    const u = await user("merge-e2e-direct-refused", 1_000_000);
    const a = await video(u.id, { seconds: 4 });
    const run = await queuedRun(u.id);
    const result = await executeAgentTurn(
      { agentRunId: run.id, directTool: { name: "merge_videos", input: { video_urls: [a, "https://cdn.example.com/x.mp4"] } } },
      createToolRegistry([mergeVideosTool]),
      () => {},
      undefined,
      runtime,
    );
    expect(result.status).toBe("FAILED");
    expect(startMagicaRun).not.toHaveBeenCalled();
    expect(callOpenRouter).not.toHaveBeenCalled();
    const message = await prisma.message.findFirstOrThrow({ where: { agentRunId: run.id, role: "ASSISTANT" } });
    expect(JSON.stringify(message.content)).toContain("MERGE_SOURCE_UNSUPPORTED");
    expect(await prisma.creditLedger.count({ where: { userId: u.id, type: "TOOL_CHARGE" } })).toBe(0);
  });

  it("direct tool-run path: an eligible merge settles Magica's actual usage once", async () => {
    const u = await user("merge-e2e-direct-ok", 1_000_000);
    const a = await video(u.id, { seconds: 4 });
    const b = await video(u.id, { seconds: 6 });
    const run = await queuedRun(u.id);
    vi.mocked(startMagicaRun).mockResolvedValueOnce({ runId: "magica_merge_direct" });
    vi.mocked(getMagicaRun).mockResolvedValueOnce(completed(12_345) as never);
    const result = await executeAgentTurn(
      { agentRunId: run.id, directTool: { name: "merge_videos", input: { video_urls: [a, b] } } },
      createToolRegistry([mergeVideosTool]),
      () => {},
      undefined,
      runtime,
    );
    expect(result.status).toBe("COMPLETED");
    expect(startMagicaRun).toHaveBeenCalledTimes(1);
    const invocation = await prisma.toolInvocation.findFirstOrThrow({ where: { agentRunId: run.id } });
    expect(invocation.creditsCharged).toBe(BigInt(12_345)); // above the 10,835 estimate: actual wins
    expect(await prisma.creditLedger.count({ where: { userId: u.id, type: "TOOL_CHARGE" } })).toBe(1);
  });
});
