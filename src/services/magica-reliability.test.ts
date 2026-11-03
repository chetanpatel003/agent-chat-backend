// Regression tests for the Magica reliability fixes (audit 2026-11-03: H1, H2,
// M1/M2, L1). Real database; Magica, OpenRouter and Trigger.dev dispatch are
// mocked — no provider is ever called.
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/providers/openrouter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/providers/openrouter")>();
  return { ...actual, callOpenRouter: vi.fn() };
});
vi.mock("@/providers/magica", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/providers/magica")>();
  return { ...actual, startMagicaRun: vi.fn(), getMagicaRun: vi.fn(), estimateNodeCredits: vi.fn() };
});
vi.mock("@/trigger/settle-tool-credits", () => ({ dispatchCreditSettlement: vi.fn().mockResolvedValue(true) }));
vi.mock("@/trigger/archive-generated-assets", () => ({ dispatchGeneratedAssetArchival: vi.fn().mockResolvedValue("dispatched") }));
vi.mock("@/services/generated-assets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/generated-assets")>();
  return { ...actual, archiveInvocationOutputs: vi.fn().mockResolvedValue(undefined), archiveRunGeneratedAssets: vi.fn().mockResolvedValue(undefined) };
});

import { callOpenRouter, type ProviderToolCall } from "@/providers/openrouter";
import { MagicaAmbiguousError, startMagicaRun, getMagicaRun, estimateNodeCredits } from "@/providers/magica";
import { prisma } from "@/lib/prisma";
import { makeTestUser, cleanupTestUsers } from "@/test-utils/db-fixtures";
import { createToolRegistry } from "@/tools/registry";
import { generateImageTool, cropImageTool, mergeVideosTool, editImageTool } from "@/tools/magica-tools";
import { extractMagicaMediaUrls } from "@/tools/magica-output";
import { extractGeneratedOutputs } from "./generated-assets";
import { executeAgentTurn, type TurnRuntime } from "@/trigger/run-agent-turn";
import { sweepBillableInvocations, STALE_RUNNING_THRESHOLD_MS } from "./billable-recovery";
import { settleToolInvocationCredits } from "./credit-settlement";
import { MessageContentSchema } from "@/contracts/message";

const createdUserIds: string[] = [];
afterAll(() => cleanupTestUsers(createdUserIds));
beforeEach(() => {
  vi.mocked(startMagicaRun).mockReset();
  vi.mocked(getMagicaRun).mockReset();
  vi.mocked(callOpenRouter).mockReset();
  vi.mocked(estimateNodeCredits).mockReset().mockResolvedValue(BigInt(1_000));
});

const E2E_TIMEOUT_MS = 40_000;
const runtime: TurnRuntime = {
  openTextStream: () => ({ write: () => {}, close: async () => {} }),
  waitpoints: { createToken: () => Promise.reject(new Error("unused")), forToken: () => Promise.reject(new Error("unused")) },
  webhooks: async () => {},
};
const registry = createToolRegistry([generateImageTool, editImageTool, cropImageTool, mergeVideosTool]);

async function user(label: string, balance = 10_000_000) {
  const u = await makeTestUser(label);
  createdUserIds.push(u.id);
  await prisma.creditAccount.create({ data: { userId: u.id, balance: BigInt(balance) } });
  return u;
}
async function queuedRun(userId: string) {
  const chat = await prisma.chat.create({ data: { userId } });
  const run = await prisma.agentRun.create({ data: { chatId: chat.id, userId, idempotencyKey: randomUUID(), status: "QUEUED" } });
  await prisma.message.create({ data: { chatId: chat.id, userId, agentRunId: run.id, role: "USER", status: "COMPLETE", content: [{ type: "text", text: "go" }] } });
  return { chat, run };
}
const toolCall = (name: string, args: Record<string, unknown>): ProviderToolCall => ({ id: randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } });
const modelCalls = (...calls: ProviderToolCall[][]) => {
  for (const c of calls) vi.mocked(callOpenRouter).mockResolvedValueOnce({ model: "x/y:free", text: null, toolCalls: c, promptTokens: 1, completionTokens: 1 });
  vi.mocked(callOpenRouter).mockResolvedValueOnce({ model: "x/y:free", text: "Done.", toolCalls: null, promptTokens: 1, completionTokens: 1 });
};
const poll = (o: Record<string, unknown>) => ({ id: "x", nodeType: "gpt_image_2", status: "COMPLETED", createdAt: "2026-01-01T00:00:00Z", ...o }) as never;
const IMAGE = "https://g.tlcdn.com/gen/aaaa.png";

describe("H1 — no duplicate provider run after an ambiguous start", { timeout: E2E_TIMEOUT_MS }, () => {
  it("records PROVIDER_OUTCOME_UNKNOWN and blocks the model's retry with the same arguments", async () => {
    const u = await user("h1-same-args");
    const { run } = await queuedRun(u.id);
    const args = { prompt: "a cat", size: "1024x1024" };
    modelCalls([toolCall("generate_image", args)], [toolCall("generate_image", args)]);
    vi.mocked(startMagicaRun).mockRejectedValueOnce(new MagicaAmbiguousError("HTTP 502", "MAGICA_START_AMBIGUOUS_5XX"));

    await executeAgentTurn({ agentRunId: run.id }, registry, () => {}, undefined, runtime);

    expect(startMagicaRun).toHaveBeenCalledTimes(1);
    const invocations = await prisma.toolInvocation.findMany({ where: { agentRunId: run.id }, orderBy: { createdAt: "asc" } });
    expect(invocations.map((i) => [i.status, i.errorCode])).toEqual([
      ["FAILED", "PROVIDER_OUTCOME_UNKNOWN"],
      ["FAILED", "PROVIDER_RETRY_BLOCKED"],
    ]);
    // The model was told, in machine-readable form, not to retry.
    const toolMessage = vi.mocked(callOpenRouter).mock.calls[1][0].find((m: { role: string }) => m.role === "tool") as { content: string };
    expect(toolMessage.content).toMatch(/Do not call generate_image again/);
    expect(await prisma.creditLedger.count({ where: { userId: u.id, type: "TOOL_CHARGE" } })).toBe(0);
  });

  it("blocks retries with different arguments too (the guard is per tool, not per input)", async () => {
    const u = await user("h1-other-args");
    const { run } = await queuedRun(u.id);
    modelCalls(
      [toolCall("generate_image", { prompt: "a cat", size: "1024x1024" })],
      [toolCall("generate_image", { prompt: "a dog", size: "1536x1024", quality: "Low" })],
      [toolCall("generate_image", { prompt: "anything else", size: "1024x1024" })],
    );
    vi.mocked(startMagicaRun).mockRejectedValueOnce(new MagicaAmbiguousError("timeout", "MAGICA_START_AMBIGUOUS_NETWORK"));

    await executeAgentTurn({ agentRunId: run.id }, registry, () => {}, undefined, runtime);

    expect(startMagicaRun).toHaveBeenCalledTimes(1);
    expect(estimateNodeCredits).toHaveBeenCalledTimes(1); // blocked calls never reach admission either
    const codes = (await prisma.toolInvocation.findMany({ where: { agentRunId: run.id }, orderBy: { createdAt: "asc" } })).map((i) => i.errorCode);
    expect(codes).toEqual(["PROVIDER_OUTCOME_UNKNOWN", "PROVIDER_RETRY_BLOCKED", "PROVIDER_RETRY_BLOCKED"]);
  });

  it("does not block a different billable tool, or the same tool in a later run (direct runs keep working)", async () => {
    const u = await user("h1-scope");
    const first = await queuedRun(u.id);
    modelCalls([toolCall("generate_image", { prompt: "a", size: "1024x1024" })], [toolCall("crop_image", { image_url: IMAGE })]);
    vi.mocked(startMagicaRun)
      .mockRejectedValueOnce(new MagicaAmbiguousError("HTTP 500", "MAGICA_START_AMBIGUOUS_5XX"))
      .mockResolvedValueOnce({ runId: "crop_run" });
    vi.mocked(getMagicaRun).mockResolvedValueOnce(poll({ output: { image_url: "https://g.tlcdn.com/gen/cropped.png" }, creditUsed: 5_000 }));
    await executeAgentTurn({ agentRunId: first.run.id }, registry, () => {}, undefined, runtime);
    expect(startMagicaRun).toHaveBeenCalledTimes(2);

    const second = await queuedRun(u.id);
    vi.mocked(startMagicaRun).mockResolvedValueOnce({ runId: "later_run" });
    vi.mocked(getMagicaRun).mockResolvedValueOnce(poll({ output: { result: [IMAGE] }, creditUsed: 1_000 }));
    const result = await executeAgentTurn(
      { agentRunId: second.run.id, directTool: { name: "generate_image", input: { prompt: "a", size: "1024x1024" } } },
      registry,
      () => {},
      undefined,
      runtime,
    );
    expect(result.status).toBe("COMPLETED");
    expect(startMagicaRun).toHaveBeenCalledTimes(3);
  });
});

describe("M1/M2 — one canonical output normalisation", { timeout: E2E_TIMEOUT_MS }, () => {
  it.each([
    ["image_url", { image_url: "https://g.tlcdn.com/gen/c1.png" }, ["https://g.tlcdn.com/gen/c1.png"]],
    ["result[]", { result: ["https://g.tlcdn.com/gen/c2.png"] }, ["https://g.tlcdn.com/gen/c2.png"]],
    ["images[]", { images: ["https://g.tlcdn.com/gen/c3.png"] }, ["https://g.tlcdn.com/gen/c3.png"]],
  ])("crop_image output shape %s: persisted as canonical images, archived from the same list", async (_label, raw, expected) => {
    expect(extractMagicaMediaUrls("crop_image", raw)).toEqual(expected);
    const u = await user("m1-crop");
    const { run } = await queuedRun(u.id);
    vi.mocked(startMagicaRun).mockResolvedValueOnce({ runId: `crop_${randomUUID()}` });
    vi.mocked(getMagicaRun).mockResolvedValueOnce(poll({ output: raw, creditUsed: 5_000 }));
    await executeAgentTurn({ agentRunId: run.id, directTool: { name: "crop_image", input: { image_url: IMAGE } } }, registry, () => {}, undefined, runtime);
    const invocation = await prisma.toolInvocation.findFirstOrThrow({ where: { agentRunId: run.id } });
    expect(invocation.status).toBe("COMPLETED");
    expect((invocation.output as { images: string[] }).images).toEqual(expected); // what the chat UI reads
    expect(extractGeneratedOutputs("crop_image", invocation.output)?.urls).toEqual(expected); // what archival reads
  });

  it("merge_videos video_url and image tools' result[] go through the same path", () => {
    expect(extractMagicaMediaUrls("merge_videos", { video_url: "https://static.magica.com/m.mp4" })).toEqual(["https://static.magica.com/m.mp4"]);
    expect(extractMagicaMediaUrls("edit_image", { result: [IMAGE] })).toEqual([IMAGE]);
    expect(extractMagicaMediaUrls("generate_image", { image_url: IMAGE })).toEqual([]); // not a field this tool returns
  });

  it.each([
    ["no media field", { somethingElse: true }],
    ["non-https URL", { result: ["http://insecure.example/a.png"] }],
    ["not a URL", { image_url: "javascript:alert(1)" }],
    ["empty list", { result: [] }],
    ["null output", null],
  ])("a completed run with %s is a visible PROVIDER_OUTPUT_INVALID failure; Magica's usage is still settled", async (_label, raw) => {
    const u = await user("m2-invalid");
    const { run } = await queuedRun(u.id);
    vi.mocked(startMagicaRun).mockResolvedValueOnce({ runId: `bad_${randomUUID()}` });
    vi.mocked(getMagicaRun).mockResolvedValueOnce(poll({ output: raw, creditUsed: 5_000 }));
    const result = await executeAgentTurn({ agentRunId: run.id, directTool: { name: "crop_image", input: { image_url: IMAGE } } }, registry, () => {}, undefined, runtime);
    expect(result.status).toBe("FAILED");
    const invocation = await prisma.toolInvocation.findFirstOrThrow({ where: { agentRunId: run.id } });
    expect([invocation.status, invocation.errorCode]).toEqual(["FAILED", "PROVIDER_OUTPUT_INVALID"]);
    const message = await prisma.message.findFirstOrThrow({ where: { agentRunId: run.id, role: "ASSISTANT" } });
    const resultBlock = MessageContentSchema.parse(message.content).find((b) => b.type === "tool_result");
    expect(resultBlock).toMatchObject({ error: { code: "PROVIDER_OUTPUT_INVALID" }, output: null });
    expect(invocation.creditsCharged).toBe(BigInt(5_000)); // actual usage, as for any failed provider run
  });
});

/** The state a turn leaves when polling ran out: run interrupted, message PENDING, invocation RUNNING with a run id. */
async function timedOutTurn(label: string, opts: { text?: string } = {}) {
  const u = await user(label);
  const { chat, run } = await queuedRun(u.id);
  const message = await prisma.message.create({
    data: { chatId: chat.id, userId: u.id, agentRunId: run.id, role: "ASSISTANT", status: "PENDING", content: opts.text ? [{ type: "text", text: opts.text }] : [] },
  });
  const invocation = await prisma.toolInvocation.create({
    data: { agentRunId: run.id, messageId: message.id, toolName: "generate_image", idempotencyKey: randomUUID(), input: { prompt: "a cat", size: "1024x1024" }, status: "RUNNING", providerRunId: `slow_${randomUUID()}` },
  });
  await prisma.agentRun.update({ where: { id: run.id }, data: { status: "FAILED", errorCode: "RUN_INTERRUPTED", completedAt: new Date() } });
  await age(run.id, invocation.id);
  return { u, chat, run, message, invocation };
}
/** Only this test's rows are made old (as in billable-recovery.test.ts), so concurrent test files are never swept. */
async function age(runId: string, invocationId: string) {
  const minutes = STALE_RUNNING_THRESHOLD_MS / 60_000 + 5;
  await prisma.$executeRaw`UPDATE "ToolInvocation" SET "updatedAt" = now() - make_interval(mins => ${minutes}) WHERE "id" = ${invocationId}::uuid`;
  await prisma.$executeRaw`UPDATE "AgentRun" SET "updatedAt" = now() - make_interval(mins => ${minutes}) WHERE "id" = ${runId}::uuid`;
}
/** Magica answers only for this test's own provider run; any other row stays "still running". */
function pollFor(providerRunId: string, result: Record<string, unknown>) {
  vi.mocked(getMagicaRun).mockImplementation(async (id: string) => {
    if (id === providerRunId) return poll(result);
    throw new Error("not this test's run");
  });
}
const deps = () => ({
  registry,
  dispatchSettlement: async (id: string) => (await settleToolInvocationCredits(id), true),
  dispatchArchival: vi.fn().mockResolvedValue(undefined),
});

describe("H2 — a result recovered after the polling budget appears in the chat, settled once", { timeout: E2E_TIMEOUT_MS }, () => {
  it("the sweep adds tool_use + tool_result to the turn's own message and shows it as a result, not 'interrupted'", async () => {
    const { u, chat, message, invocation } = await timedOutTurn("h2-recover", { text: "Generating your image" });
    const other = await prisma.message.create({ data: { chatId: chat.id, userId: u.id, role: "ASSISTANT", status: "COMPLETE", content: [{ type: "text", text: "older" }] } });
    pollFor(invocation.providerRunId as string, { output: { result: [IMAGE] }, creditUsed: 273_936 });

    await sweepBillableInvocations(deps());
    expect((await prisma.toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } })).status).toBe("COMPLETED");

    const updated = await prisma.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(updated.status).toBe("COMPLETE");
    const blocks = MessageContentSchema.parse(updated.content);
    expect(blocks.map((b) => b.type)).toEqual(["text", "tool_use", "tool_result"]);
    expect(blocks[1]).toMatchObject({ toolInvocationId: invocation.id, status: "COMPLETED", toolName: "generate_image" });
    expect(blocks[2]).toMatchObject({ toolInvocationId: invocation.id, error: null, output: { images: [IMAGE] } });
    expect((await prisma.message.findUniqueOrThrow({ where: { id: other.id } })).content).toEqual([{ type: "text", text: "older" }]);
    expect(startMagicaRun).not.toHaveBeenCalled();
    const ledger = await prisma.creditLedger.findMany({ where: { userId: u.id, type: "TOOL_CHARGE" } });
    expect(ledger.map((l) => l.amount)).toEqual([BigInt(-273_936)]);
  });

  it("repeated sweeps and concurrent settlement charge once and attach once", async () => {
    const { u, message, invocation } = await timedOutTurn("h2-concurrent");
    pollFor(invocation.providerRunId as string, { output: { result: [IMAGE] }, creditUsed: 68_484 });

    await Promise.all([
      sweepBillableInvocations(deps()),
      sweepBillableInvocations(deps()),
      settleToolInvocationCredits(invocation.id),
    ]);
    await sweepBillableInvocations(deps());
    await settleToolInvocationCredits(invocation.id);

    expect(await prisma.creditLedger.count({ where: { userId: u.id, type: "TOOL_CHARGE" } })).toBe(1);
    expect((await prisma.toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } })).creditsCharged).toBe(BigInt(68_484));
    const blocks = MessageContentSchema.parse((await prisma.message.findUniqueOrThrow({ where: { id: message.id } })).content);
    expect(blocks.filter((b) => b.type === "tool_result")).toHaveLength(1);
    expect(blocks.filter((b) => b.type === "tool_use")).toHaveLength(1);
  });

  it("a failed recovered run is attached as a failed result and leaves the interrupted message as it was", async () => {
    const { message, invocation } = await timedOutTurn("h2-failed");
    pollFor(invocation.providerRunId as string, { status: "FAILED", error: "content policy", creditUsed: 0 });
    await sweepBillableInvocations(deps());
    const updated = await prisma.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(updated.status).toBe("PENDING"); // still reported as the run's interruption
    const result = MessageContentSchema.parse(updated.content).find((b) => b.type === "tool_result");
    expect(result).toMatchObject({ error: { code: "MAGICA_RUN_FAILED" } });
  });

  it("a completed result with no valid media is recovered as PROVIDER_OUTPUT_INVALID, not a success", async () => {
    const { message, invocation } = await timedOutTurn("h2-invalid");
    pollFor(invocation.providerRunId as string, { output: { result: ["http://x/a.png"] }, creditUsed: 100 });
    await sweepBillableInvocations(deps());
    expect((await prisma.toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } })).errorCode).toBe("PROVIDER_OUTPUT_INVALID");
    expect((await prisma.message.findUniqueOrThrow({ where: { id: message.id } })).status).toBe("PENDING");
  });
});

describe("L1 — orphan RUNNING invocations with no provider run id", { timeout: E2E_TIMEOUT_MS }, () => {
  async function orphan(label: string, runStatus: "FAILED" | "RUNNING") {
    const u = await user(label);
    const { chat, run } = await queuedRun(u.id);
    const message = await prisma.message.create({ data: { chatId: chat.id, userId: u.id, agentRunId: run.id, role: "ASSISTANT", status: "PENDING", content: [] } });
    const invocation = await prisma.toolInvocation.create({
      data: { agentRunId: run.id, messageId: message.id, toolName: "generate_image", idempotencyKey: randomUUID(), input: { prompt: "x", size: "1024x1024" }, status: "RUNNING" },
    });
    await prisma.agentRun.update({ where: { id: run.id }, data: { status: runStatus } });
    await age(run.id, invocation.id);
    return { u, message, invocation };
  }

  it("is closed as PROVIDER_OUTCOME_UNKNOWN once its run has ended: never reconciled, started or charged", async () => {
    const { u, message, invocation } = await orphan("l1-closed", "FAILED");
    vi.mocked(getMagicaRun).mockRejectedValue(new Error("not this test's run"));
    await sweepBillableInvocations(deps());
    const closed = await prisma.toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } });
    expect([closed.status, closed.errorCode, closed.creditsCharged, closed.providerRunId]).toEqual(["FAILED", "PROVIDER_OUTCOME_UNKNOWN", null, null]);
    // It has no run id, so it can't have been polled; and nothing ever starts a run.
    expect(startMagicaRun).not.toHaveBeenCalled();
    expect(await prisma.creditLedger.count({ where: { userId: u.id } })).toBe(0);
    const result = MessageContentSchema.parse((await prisma.message.findUniqueOrThrow({ where: { id: message.id } })).content).find((b) => b.type === "tool_result");
    expect(result).toMatchObject({ error: { code: "PROVIDER_OUTCOME_UNKNOWN" } });
    await sweepBillableInvocations(deps()); // idempotent: closed once, attached once
    const blocks = MessageContentSchema.parse((await prisma.message.findUniqueOrThrow({ where: { id: message.id } })).content);
    expect(blocks.filter((b) => b.type === "tool_result")).toHaveLength(1);
  });

  it("is left alone while its run is still active", async () => {
    const { invocation } = await orphan("l1-active", "RUNNING");
    vi.mocked(getMagicaRun).mockRejectedValue(new Error("not this test's run"));
    await sweepBillableInvocations(deps());
    expect((await prisma.toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } })).status).toBe("RUNNING");
  });
});
