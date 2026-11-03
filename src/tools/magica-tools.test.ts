import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/providers/openrouter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/providers/openrouter")>();
  return { ...actual, callOpenRouter: vi.fn() };
});
vi.mock("@/providers/magica", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/providers/magica")>();
  return { ...actual, startMagicaRun: vi.fn(), getMagicaRun: vi.fn() };
});
// These tests cover tool execution, not archival (generated-assets.test.ts
// does): keep fixture output URLs from ever being fetched.
// Admission (balance/estimate checks) is covered by credit-admission.test.ts;
// these tests cover execution, so admission is allowed here.
vi.mock("@/services/credit-admission", () => ({ admitBillableRun: vi.fn().mockResolvedValue(BigInt(0)) }));
// merge_videos' source/duration admission (merge-admission.test.ts) needs real uploads; the
// execution tests below use placeholder URLs, so it is allowed here too.
vi.mock("@/services/merge-admission", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/merge-admission")>();
  return { ...actual, resolveMergeSources: vi.fn().mockResolvedValue({ videoCount: 2, totalSeconds: 10 }) };
});
// Never dispatch a real Trigger.dev settlement task from these tests (inline settlement still runs).
vi.mock("@/trigger/settle-tool-credits", () => ({ dispatchCreditSettlement: vi.fn().mockResolvedValue(true) }));
// Never dispatch a real Trigger.dev archival task from these tests.
vi.mock("@/trigger/archive-generated-assets", () => ({
  dispatchGeneratedAssetArchival: vi.fn().mockResolvedValue("dispatched"),
}));
vi.mock("@/services/generated-assets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/generated-assets")>();
  return {
    ...actual,
    archiveInvocationOutputs: vi.fn().mockResolvedValue(undefined),
    archiveRunGeneratedAssets: vi.fn().mockResolvedValue(undefined),
  };
});

import { callOpenRouter, type ProviderToolCall } from "@/providers/openrouter";
import { startMagicaRun, getMagicaRun } from "@/providers/magica";
import { prisma } from "@/lib/prisma";
import { makeTestUser, cleanupTestUsers } from "@/test-utils/db-fixtures";
import { createToolRegistry, toOpenRouterTools, PRODUCTION_TOOL_REGISTRY } from "./registry";
import { generateImageTool, editImageTool, cropImageTool, mergeVideosTool } from "./magica-tools";
import { executeAgentTurn } from "@/trigger/run-agent-turn";
import { dispatchGeneratedAssetArchival } from "@/trigger/archive-generated-assets";
import { dispatchCreditSettlement } from "@/trigger/settle-tool-credits";
import type { PublishRunEvent } from "@/realtime/publish-run-event";
import type { RunEvent } from "@/contracts/run-event";

const mockCallOpenRouter = vi.mocked(callOpenRouter);
const mockStartMagicaRun = vi.mocked(startMagicaRun);
const mockGetMagicaRun = vi.mocked(getMagicaRun);
// Agent-loop tests now also settle credits (a locked transaction against the
// remote test database); measured at ~20.6s, just over the 20s suite default.
const AGENT_LOOP_WITH_SETTLEMENT_TIMEOUT_MS = 40_000;

const createdUserIds: string[] = [];
const noopPublish: PublishRunEvent = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  mockCallOpenRouter.mockReset();
  mockStartMagicaRun.mockReset();
  mockGetMagicaRun.mockReset();
});
afterAll(() => cleanupTestUsers(createdUserIds));

async function user(label: string) {
  const u = await makeTestUser(label);
  createdUserIds.push(u.id);
  return u;
}

async function setUpRun(owner: { id: string }) {
  const chat = await prisma.chat.create({ data: { userId: owner.id } });
  const run = await prisma.agentRun.create({
    data: { chatId: chat.id, userId: owner.id, idempotencyKey: randomUUID(), status: "QUEUED" },
  });
  await prisma.message.create({
    data: { chatId: chat.id, userId: owner.id, agentRunId: run.id, role: "USER", status: "COMPLETE", content: [{ type: "text", text: "hi" }] },
  });
  return { chat, run };
}

function toolCall(name: string, args: Record<string, unknown>, id = randomUUID()): ProviderToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}
function finalAnswer(text: string) {
  return { model: "x/y:free", text, toolCalls: null, promptTokens: 1, completionTokens: 1 };
}
function toolRequest(calls: ProviderToolCall[], text: string | null = null) {
  return { model: "x/y:free", text, toolCalls: calls, promptTokens: 1, completionTokens: 1 };
}
function pollResult(overrides: Partial<Record<string, unknown>> = {}) {
  return { id: "x", nodeType: "gpt_image_2", status: "RUNNING", createdAt: "2026-01-01T00:00:00Z", ...overrides };
}

describe("generate_image — input validation (real discovered gpt-image-2-text schema)", () => {
  it("accepts a minimal valid input (prompt only)", () => {
    expect(generateImageTool.inputSchema.safeParse({ prompt: "a cat" }).success).toBe(true);
  });

  it("accepts a full valid input with every optional field", () => {
    const result = generateImageTool.inputSchema.safeParse({
      prompt: "a cat",
      size: "1536x1024",
      quality: "Low",
      background: "Opaque",
      n: 2,
      output_format: "WebP",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid custom size object", () => {
    expect(generateImageTool.inputSchema.safeParse({ prompt: "a cat", size: { width: 1024, height: 1024 } }).success).toBe(true);
  });

  it("rejects a prompt over 4000 characters", () => {
    expect(generateImageTool.inputSchema.safeParse({ prompt: "x".repeat(4001) }).success).toBe(false);
  });

  it("rejects an empty prompt", () => {
    expect(generateImageTool.inputSchema.safeParse({ prompt: "" }).success).toBe(false);
  });

  it("rejects a custom size whose width/height are not multiples of 16", () => {
    expect(generateImageTool.inputSchema.safeParse({ prompt: "x", size: { width: 1920, height: 1080 } }).success).toBe(false);
  });

  it("rejects a custom size with a long-to-short ratio over 3:1", () => {
    expect(generateImageTool.inputSchema.safeParse({ prompt: "x", size: { width: 3840, height: 1024 } }).success).toBe(false);
  });

  it("rejects a custom size outside the documented pixel range", () => {
    expect(generateImageTool.inputSchema.safeParse({ prompt: "x", size: { width: 1024, height: 512 } }).success).toBe(false);
  });

  it("rejects an unsupported quality value", () => {
    expect(generateImageTool.inputSchema.safeParse({ prompt: "x", quality: "Ultra" }).success).toBe(false);
  });

  it("rejects an unsupported n value", () => {
    expect(generateImageTool.inputSchema.safeParse({ prompt: "x", n: 5 }).success).toBe(false);
  });

  it("rejects a non-HTTPS size preset string that isn't one of the documented presets", () => {
    expect(generateImageTool.inputSchema.safeParse({ prompt: "x", size: "4096x4096" }).success).toBe(false);
  });
});

describe("generate_image — registration and OpenRouter schema generation", () => {
  it("is registered in PRODUCTION_TOOL_REGISTRY", () => {
    expect(PRODUCTION_TOOL_REGISTRY.get("generate_image")).toBe(generateImageTool);
  });

  it("generates an OpenRouter tool schema from its own Zod input schema", () => {
    const specs = toOpenRouterTools(PRODUCTION_TOOL_REGISTRY);
    const spec = specs.find((s) => s.function.name === "generate_image");
    expect(spec).toBeDefined();
    expect(spec!.function.parameters).toMatchObject({ type: "object", required: ["prompt"] });
  });

  it("existing skill tools remain registered alongside it", () => {
    expect(PRODUCTION_TOOL_REGISTRY.get("load_skill")).toBeDefined();
    expect(PRODUCTION_TOOL_REGISTRY.get("read_skill_asset")).toBeDefined();
  });
});

describe("generate_image — through the real agent loop", { timeout: AGENT_LOOP_WITH_SETTLEMENT_TIMEOUT_MS }, () => {
  it("starts once with the correct nodeType/subModelId, persists providerRunId, and completes with normalized output", async () => {
    const owner = await user("genimg-happy-path");
    const { run } = await setUpRun(owner);
    const call = toolCall("generate_image", { prompt: "a red bicycle", quality: "Low" });

    mockCallOpenRouter.mockResolvedValueOnce(toolRequest([call]));
    mockCallOpenRouter.mockResolvedValueOnce(finalAnswer("done"));
    mockStartMagicaRun.mockResolvedValueOnce({ runId: "magica_run_img_1" });
    mockGetMagicaRun.mockResolvedValueOnce(
      pollResult({ status: "COMPLETED", output: { images: ["https://cdn.example.com/out.png"] }, creditUsed: 42 }),
    );

    const result = await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([generateImageTool]), noopPublish);
    expect(result.status).toBe("COMPLETED");

    expect(mockStartMagicaRun).toHaveBeenCalledTimes(1);
    expect(mockStartMagicaRun).toHaveBeenCalledWith("gpt_image_2", { prompt: "a red bicycle", quality: "Low" }, "gpt-image-2-text");

    const invocation = await prisma.toolInvocation.findFirstOrThrow({ where: { agentRunId: run.id } });
    expect(invocation.status).toBe("COMPLETED");
    expect(invocation.providerRunId).toBe("magica_run_img_1");
    expect(invocation.output).toEqual({
      raw: { images: ["https://cdn.example.com/out.png"] },
      images: ["https://cdn.example.com/out.png"],
      creditUsed: 42,
    });
    // Archival is dispatched as its own task, once, after COMPLETED is persisted.
    expect(vi.mocked(dispatchGeneratedAssetArchival)).toHaveBeenCalledWith(invocation.id);
  });

  it("extracts images from the real observed output shape ({result: [...]}, confirmed by one live call — see LIVE_VERIFICATION.md), not the unverified {images: [...]} guess", async () => {
    const owner = await user("genimg-real-shape");
    const { run } = await setUpRun(owner);
    const call = toolCall("generate_image", { prompt: "x" });
    const rawOutput = {
      result: ["https://static.magica.com/real-example.png"],
      provider: "fal",
      resultMetadata: [{ size: 123, width: 1313, height: 1198, modelId: "gpt-image-2", mimeType: "image/png", mediaType: "image" }],
    };

    mockCallOpenRouter.mockResolvedValueOnce(toolRequest([call]));
    mockCallOpenRouter.mockResolvedValueOnce(finalAnswer("done"));
    mockStartMagicaRun.mockResolvedValueOnce({ runId: "magica_run_img_real" });
    mockGetMagicaRun.mockResolvedValueOnce(pollResult({ status: "COMPLETED", output: rawOutput, creditUsed: 8385 }));

    await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([generateImageTool]), noopPublish);

    const invocation = await prisma.toolInvocation.findFirstOrThrow({ where: { agentRunId: run.id } });
    expect(invocation.output).toEqual({ raw: rawOutput, images: ["https://static.magica.com/real-example.png"], creditUsed: 8385 });
  });

  it("a completed run with no recognisable media is a visible PROVIDER_OUTPUT_INVALID failure, never an empty success", async () => {
    const owner = await user("genimg-no-images-field");
    const { run } = await setUpRun(owner);
    const call = toolCall("generate_image", { prompt: "x" });

    mockCallOpenRouter.mockResolvedValueOnce(toolRequest([call]));
    mockCallOpenRouter.mockResolvedValueOnce(finalAnswer("done"));
    mockStartMagicaRun.mockResolvedValueOnce({ runId: "magica_run_img_2" });
    mockGetMagicaRun.mockResolvedValueOnce(pollResult({ status: "COMPLETED", output: { somethingElse: true } }));

    await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([generateImageTool]), noopPublish);

    const invocation = await prisma.toolInvocation.findFirstOrThrow({ where: { agentRunId: run.id } });
    // M2 (audit 2026-11-03): formerly persisted as COMPLETED `{ raw }` with nothing to show.
    expect(invocation.status).toBe("FAILED");
    expect(invocation.errorCode).toBe("PROVIDER_OUTPUT_INVALID");
    expect(JSON.stringify(invocation.output ?? {})).not.toContain("images"); // nothing invented
  });

  it("reports provider_waiting once, after the provider accepted the job and before its result", async () => {
    const owner = await user("genimg-progress");
    const { run } = await setUpRun(owner);
    const events: RunEvent[] = [];
    mockCallOpenRouter.mockResolvedValueOnce(toolRequest([toolCall("generate_image", { prompt: "x", size: "1024x1024" })]));
    mockCallOpenRouter.mockResolvedValueOnce(finalAnswer("done"));
    mockStartMagicaRun.mockResolvedValueOnce({ runId: "magica_run_progress" });
    mockGetMagicaRun.mockResolvedValueOnce(pollResult({ status: "COMPLETED", output: { result: ["https://g.tlcdn.com/gen/p.png"] }, creditUsed: 1 }));

    await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([generateImageTool]), (e) => {
      events.push(e);
    });

    const toolEvents = events.filter((e) => e.type.startsWith("tool_"));
    // Generic lifecycle: calling (started, with the tool's display) → Magica's
    // activity once the job is accepted → receiving → saving → completed.
    expect(toolEvents.map((e) => (e.type === "tool_progress" ? `progress:${e.phase}` : e.type))).toEqual([
      "tool_started",
      "progress:provider_waiting",
      "progress:receiving",
      "progress:saving",
      "tool_completed",
    ]);
    expect(toolEvents[0]).toMatchObject({ display: { name: "GPT Image 2", activity: "Generating image with Magica" } });
    expect(toolEvents.filter((e) => e.type === "tool_progress" && e.phase === "provider_waiting")).toHaveLength(1);
    // Each emitted with a seq between start and completion, so the UI can order them.
    const seqs = toolEvents.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it("does not report provider_waiting when the start itself fails", async () => {
    const owner = await user("genimg-progress-nostart");
    const { run } = await setUpRun(owner);
    const events: RunEvent[] = [];
    const { MagicaAmbiguousError } = await import("@/providers/magica");
    mockCallOpenRouter.mockResolvedValueOnce(toolRequest([toolCall("generate_image", { prompt: "x", size: "1024x1024" })]));
    mockCallOpenRouter.mockResolvedValueOnce(finalAnswer("done"));
    mockStartMagicaRun.mockRejectedValueOnce(new MagicaAmbiguousError("HTTP 500", "MAGICA_START_AMBIGUOUS_5XX"));

    await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([generateImageTool]), (e) => {
      events.push(e);
    });
    expect(events.some((e) => e.type === "tool_progress" && e.phase === "provider_waiting")).toBe(false);
    expect(mockStartMagicaRun).toHaveBeenCalledTimes(1);
  });

  it("a failing progress publish never affects the started run (no failure, no second start)", async () => {
    const owner = await user("genimg-progress-publish-fails");
    const { run } = await setUpRun(owner);
    mockCallOpenRouter.mockResolvedValueOnce(toolRequest([toolCall("generate_image", { prompt: "x", size: "1024x1024" })]));
    mockCallOpenRouter.mockResolvedValueOnce(finalAnswer("done"));
    mockStartMagicaRun.mockResolvedValueOnce({ runId: "magica_run_progress_fail" });
    mockGetMagicaRun.mockResolvedValueOnce(pollResult({ status: "COMPLETED", output: { result: ["https://g.tlcdn.com/gen/q.png"] }, creditUsed: 1 }));

    const result = await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([generateImageTool]), (e) => {
      if (e.type === "tool_progress") throw new Error("realtime down");
    });
    expect(result.status).toBe("COMPLETED");
    expect(mockStartMagicaRun).toHaveBeenCalledTimes(1);
    const invocation = await prisma.toolInvocation.findFirstOrThrow({ where: { agentRunId: run.id } });
    expect(invocation.status).toBe("COMPLETED");
  });

  it("an ambiguous start is recorded as a failed tool call and never automatically resubmitted", async () => {
    const owner = await user("genimg-ambiguous-start");
    const { run } = await setUpRun(owner);
    const call = toolCall("generate_image", { prompt: "x" });
    const { MagicaAmbiguousError } = await import("@/providers/magica");

    mockCallOpenRouter.mockResolvedValueOnce(toolRequest([call]));
    mockCallOpenRouter.mockResolvedValueOnce(finalAnswer("done"));
    mockStartMagicaRun.mockRejectedValueOnce(new MagicaAmbiguousError("HTTP 500", "MAGICA_START_AMBIGUOUS_5XX"));

    await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([generateImageTool]), noopPublish);
    expect(mockStartMagicaRun).toHaveBeenCalledTimes(1);

    const invocation = await prisma.toolInvocation.findFirstOrThrow({ where: { agentRunId: run.id } });
    expect(invocation.status).toBe("FAILED");
    expect(invocation.providerRunId).toBeNull();
  });

  it("a provider terminal failure (FAILED) ends the tool call as FAILED with the real error message", async () => {
    const owner = await user("genimg-provider-failed");
    const { run } = await setUpRun(owner);
    const call = toolCall("generate_image", { prompt: "x" });

    mockCallOpenRouter.mockResolvedValueOnce(toolRequest([call]));
    mockCallOpenRouter.mockResolvedValueOnce(finalAnswer("done"));
    mockStartMagicaRun.mockResolvedValueOnce({ runId: "magica_run_img_3" });
    mockGetMagicaRun.mockResolvedValueOnce(pollResult({ status: "FAILED", userMessage: "content policy violation" }));

    await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([generateImageTool]), noopPublish);

    const invocation = await prisma.toolInvocation.findFirstOrThrow({ where: { agentRunId: run.id } });
    expect(invocation.status).toBe("FAILED");
    expect(invocation.errorMessage).toBe("content policy violation");
  });

  it("keeps a failed run's reported usage, with unchanged error semantics, and settles it", async () => {
    const owner = await user("genimg-failed-usage");
    await prisma.creditAccount.create({ data: { userId: owner.id, balance: BigInt(100_000) } });
    const { run } = await setUpRun(owner);
    mockCallOpenRouter.mockResolvedValueOnce(toolRequest([toolCall("generate_image", { prompt: "x", size: "1024x1024" })]));
    mockCallOpenRouter.mockResolvedValueOnce(finalAnswer("done"));
    mockStartMagicaRun.mockResolvedValueOnce({ runId: "magica_run_failed_usage" });
    mockGetMagicaRun.mockResolvedValueOnce(pollResult({ status: "FAILED", userMessage: "content policy violation", creditUsed: 5000 }));

    await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([generateImageTool]), noopPublish);

    const invocation = await prisma.toolInvocation.findFirstOrThrow({ where: { agentRunId: run.id } });
    expect(invocation).toMatchObject({
      status: "FAILED",
      errorCode: "EXECUTION_FAILED",
      errorMessage: "content policy violation",
      output: { creditUsed: 5000 },
      creditsCharged: BigInt(5000),
    });
    expect((await prisma.creditAccount.findUniqueOrThrow({ where: { userId: owner.id } })).balance).toBe(BigInt(95_000));
  });

  it("settles a completed run's raw creditUsed and reports it on the tool_result block", async () => {
    const owner = await user("genimg-settled");
    await prisma.creditAccount.create({ data: { userId: owner.id, balance: BigInt(1_000_000) } });
    const { run } = await setUpRun(owner);
    mockCallOpenRouter.mockResolvedValueOnce(toolRequest([toolCall("generate_image", { prompt: "x", quality: "High", size: "1024x1024" })]));
    mockCallOpenRouter.mockResolvedValueOnce(finalAnswer("done"));
    mockStartMagicaRun.mockResolvedValueOnce({ runId: "magica_run_settled" });
    mockGetMagicaRun.mockResolvedValueOnce(
      pollResult({ status: "COMPLETED", output: { result: ["https://cdn.example.com/k.png"] }, creditUsed: 273936 }),
    );

    await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([generateImageTool]), noopPublish);

    const invocation = await prisma.toolInvocation.findFirstOrThrow({ where: { agentRunId: run.id } });
    expect(invocation.creditsCharged).toBe(BigInt(273936));
    expect((await prisma.creditAccount.findUniqueOrThrow({ where: { userId: owner.id } })).balance).toBe(BigInt(726_064));
    const message = await prisma.message.findFirstOrThrow({ where: { agentRunId: run.id, role: "ASSISTANT" } });
    const result = (message.content as Array<Record<string, unknown>>).find((b) => b.type === "tool_result");
    expect(result?.creditsCharged).toBe(273936);
    expect(vi.mocked(dispatchCreditSettlement)).toHaveBeenCalledWith(invocation.id);
  });

  it("keeps the charge recoverable when inline settlement fails: outcome unchanged, durable settlement dispatched", async () => {
    const owner = await user("genimg-settle-fails");
    await prisma.creditAccount.create({ data: { userId: owner.id, balance: BigInt(1_000_000) } });
    const { run } = await setUpRun(owner);
    mockCallOpenRouter.mockResolvedValueOnce(toolRequest([toolCall("generate_image", { prompt: "x", size: "1024x1024" })]));
    mockCallOpenRouter.mockResolvedValueOnce(finalAnswer("done"));
    mockStartMagicaRun.mockResolvedValueOnce({ runId: "magica_run_settle_fails" });
    mockGetMagicaRun.mockResolvedValueOnce(
      pollResult({ status: "COMPLETED", output: { result: ["https://cdn.example.com/s.png"] }, creditUsed: 5000 }),
    );
    const spy = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("connection reset"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([generateImageTool]), noopPublish);
    spy.mockRestore();

    expect(result.status).toBe("COMPLETED");
    const invocation = await prisma.toolInvocation.findFirstOrThrow({ where: { agentRunId: run.id } });
    expect(invocation.status).toBe("COMPLETED");
    expect(invocation.creditsCharged).toBeNull(); // not yet collected …
    expect(vi.mocked(dispatchCreditSettlement)).toHaveBeenCalledWith(invocation.id); // … but durably queued
  });

  it("a persistence failure after 202 (the invocation moved on before the write landed) never triggers another start", async () => {
    const owner = await user("genimg-persist-failure");
    const { run } = await setUpRun(owner);
    const call = toolCall("generate_image", { prompt: "x" });

    mockCallOpenRouter.mockResolvedValueOnce(toolRequest([call]));
    mockCallOpenRouter.mockResolvedValueOnce(finalAnswer("done"));
    // Simulated deterministically, exercised for real rather than
    // mocked: between the 202 "arriving" and persistProviderRunId's
    // own guarded write, the invocation's status is flipped away from
    // RUNNING — its guard (status must still be RUNNING) then
    // correctly refuses the write, exactly as it would for a genuine
    // race with another writer.
    mockStartMagicaRun.mockImplementationOnce(async () => {
      await prisma.toolInvocation.updateMany({ where: { agentRunId: run.id }, data: { status: "CANCELLED" } });
      return { runId: "magica_run_img_4" };
    });

    await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([generateImageTool]), noopPublish);
    expect(mockStartMagicaRun).toHaveBeenCalledTimes(1); // never called a second time
    expect(mockGetMagicaRun).not.toHaveBeenCalled(); // never reaches polling

    // The run may exist at Magica but can't be tracked: recorded as an
    // unknown provider outcome (H1), which also blocks further calls to
    // this tool in the run — still never a second start.
    const invocation = await prisma.toolInvocation.findFirstOrThrow({ where: { agentRunId: run.id } });
    expect(invocation.status).toBe("FAILED");
    expect(invocation.errorCode).toBe("PROVIDER_OUTCOME_UNKNOWN");
    expect(invocation.providerRunId).toBeNull(); // the persistence write never landed
  });
});

describe("generate_image — reconciliation on re-entry", { timeout: AGENT_LOOP_WITH_SETTLEMENT_TIMEOUT_MS }, () => {
  it("a completed remote run discovered by reconcile() is persisted; never starts a second run", async () => {
    const owner = await user("genimg-reconcile-completed");
    const { chat, run } = await setUpRun(owner);
    await prisma.agentRun.update({ where: { id: run.id }, data: { status: "RUNNING", startedAt: new Date() } });
    await prisma.message.create({
      data: { chatId: chat.id, userId: owner.id, agentRunId: run.id, role: "ASSISTANT", status: "PENDING", content: [] },
    });
    const stale = await prisma.toolInvocation.create({
      data: { agentRunId: run.id, toolName: "generate_image", idempotencyKey: randomUUID(), input: {}, status: "RUNNING", providerRunId: `magica_run_reentry_${randomUUID()}` },
    });
    await prisma.$executeRaw`UPDATE "AgentRun" SET "updatedAt" = ${new Date(Date.now() - 5 * 60_000)} WHERE "id" = ${run.id}::uuid`;

    mockGetMagicaRun.mockResolvedValueOnce(pollResult({ status: "COMPLETED", output: { images: ["https://cdn.example.com/recovered.png"] } }));

    const result = await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([generateImageTool]), noopPublish);
    expect(result.ambiguous).toBe(true);
    expect(mockStartMagicaRun).not.toHaveBeenCalled();

    const updated = await prisma.toolInvocation.findUniqueOrThrow({ where: { id: stale.id } });
    expect(updated.status).toBe("COMPLETED");
    expect(updated.output).toEqual({ raw: { images: ["https://cdn.example.com/recovered.png"] }, images: ["https://cdn.example.com/recovered.png"] });
  });
});

// The shared start/persist/poll/reconcile mechanism (createMagicaTool)
// is already exhaustively covered above via generate_image. The
// following three tools reuse that exact factory, so their own tests
// focus on what's actually new per tool: input validation against
// each real discovered schema, registration, and one through-the-loop
// test confirming correct nodeType/subModelId wiring and input
// passthrough.

describe("edit_image — input validation (real discovered gpt-image-2-edit schema)", () => {
  it("accepts a minimal valid input (prompt + one uploaded image)", () => {
    expect(
      editImageTool.inputSchema.safeParse({ prompt: "make it blue", uploadedImages: ["https://cdn.example.com/a.png"] }).success,
    ).toBe(true);
  });

  it("accepts up to 10 uploaded images", () => {
    const uploadedImages = Array.from({ length: 10 }, (_, i) => `https://cdn.example.com/${i}.png`);
    expect(editImageTool.inputSchema.safeParse({ prompt: "x", uploadedImages }).success).toBe(true);
  });

  it("rejects 11 uploaded images", () => {
    const uploadedImages = Array.from({ length: 11 }, (_, i) => `https://cdn.example.com/${i}.png`);
    expect(editImageTool.inputSchema.safeParse({ prompt: "x", uploadedImages }).success).toBe(false);
  });

  it("rejects a missing uploadedImages field — never silently falls back to text-to-image", () => {
    expect(editImageTool.inputSchema.safeParse({ prompt: "x" }).success).toBe(false);
  });

  it("rejects an empty uploadedImages array", () => {
    expect(editImageTool.inputSchema.safeParse({ prompt: "x", uploadedImages: [] }).success).toBe(false);
  });

  it("rejects a non-HTTPS uploaded image URL", () => {
    expect(editImageTool.inputSchema.safeParse({ prompt: "x", uploadedImages: ["http://cdn.example.com/a.png"] }).success).toBe(
      false,
    );
  });

  it("rejects an empty prompt", () => {
    expect(editImageTool.inputSchema.safeParse({ prompt: "", uploadedImages: ["https://cdn.example.com/a.png"] }).success).toBe(
      false,
    );
  });

  it("accepts the same optional size/quality/background/n/output_format fields as generate_image", () => {
    expect(
      editImageTool.inputSchema.safeParse({
        prompt: "x",
        uploadedImages: ["https://cdn.example.com/a.png"],
        size: "1024x1024",
        quality: "High",
        background: "Auto",
        n: 1,
        output_format: "PNG",
      }).success,
    ).toBe(true);
  });
});

describe("edit_image — registration and through the real agent loop", { timeout: AGENT_LOOP_WITH_SETTLEMENT_TIMEOUT_MS }, () => {
  it("is registered in PRODUCTION_TOOL_REGISTRY", () => {
    expect(PRODUCTION_TOOL_REGISTRY.get("edit_image")).toBe(editImageTool);
  });

  it("generates an OpenRouter tool schema requiring prompt and uploadedImages", () => {
    const spec = toOpenRouterTools(PRODUCTION_TOOL_REGISTRY).find((s) => s.function.name === "edit_image");
    expect(spec).toBeDefined();
    expect(spec!.function.parameters).toMatchObject({ type: "object", required: ["prompt", "uploadedImages"] });
  });

  it("starts with nodeType gpt_image_2 and subModelId gpt-image-2-edit, and completes with normalized output", async () => {
    const owner = await user("editimg-happy-path");
    const { run } = await setUpRun(owner);
    const input = { prompt: "make it blue", uploadedImages: ["https://cdn.example.com/a.png"] };
    const call = toolCall("edit_image", input);

    mockCallOpenRouter.mockResolvedValueOnce(toolRequest([call]));
    mockCallOpenRouter.mockResolvedValueOnce(finalAnswer("done"));
    mockStartMagicaRun.mockResolvedValueOnce({ runId: "magica_run_edit_1" });
    mockGetMagicaRun.mockResolvedValueOnce(pollResult({ status: "COMPLETED", output: { result: ["https://cdn.example.com/out.png"] } }));

    const result = await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([editImageTool]), noopPublish);
    expect(result.status).toBe("COMPLETED");
    expect(mockStartMagicaRun).toHaveBeenCalledWith("gpt_image_2", input, "gpt-image-2-edit");

    const invocation = await prisma.toolInvocation.findFirstOrThrow({ where: { agentRunId: run.id } });
    expect(invocation.status).toBe("COMPLETED");
    expect(invocation.output).toMatchObject({ images: ["https://cdn.example.com/out.png"] });
  });
});

describe("crop_image — input validation (real discovered schema)", () => {
  it("accepts a minimal valid input (image_url only)", () => {
    expect(cropImageTool.inputSchema.safeParse({ image_url: "https://cdn.example.com/a.png" }).success).toBe(true);
  });

  it("accepts percentage-based crop parameters", () => {
    expect(
      cropImageTool.inputSchema.safeParse({
        image_url: "https://cdn.example.com/a.png",
        x_percent: 10,
        y_percent: 20,
        width_percent: 50,
        height_percent: 50,
      }).success,
    ).toBe(true);
  });

  it("accepts pixel-based crop parameters", () => {
    expect(
      cropImageTool.inputSchema.safeParse({
        image_url: "https://cdn.example.com/a.png",
        x_px: 10,
        y_px: 20,
        width_px: 500,
        height_px: 500,
      }).success,
    ).toBe(true);
  });

  it("rejects a missing image_url", () => {
    expect(cropImageTool.inputSchema.safeParse({ width_px: 100 }).success).toBe(false);
  });

  it("rejects a non-HTTPS image_url", () => {
    expect(cropImageTool.inputSchema.safeParse({ image_url: "http://cdn.example.com/a.png" }).success).toBe(false);
  });

  it("rejects a percent value over 100", () => {
    expect(cropImageTool.inputSchema.safeParse({ image_url: "https://cdn.example.com/a.png", width_percent: 150 }).success).toBe(
      false,
    );
  });

  it("rejects a negative percent value", () => {
    expect(cropImageTool.inputSchema.safeParse({ image_url: "https://cdn.example.com/a.png", x_percent: -5 }).success).toBe(false);
  });

  it("rejects a non-integer pixel value", () => {
    expect(cropImageTool.inputSchema.safeParse({ image_url: "https://cdn.example.com/a.png", width_px: 100.5 }).success).toBe(
      false,
    );
  });

  it("rejects a zero width_px (preserves the documented minimum of 1 pixel)", () => {
    expect(cropImageTool.inputSchema.safeParse({ image_url: "https://cdn.example.com/a.png", width_px: 0 }).success).toBe(false);
  });
});

describe("crop_image — registration and through the real agent loop", { timeout: AGENT_LOOP_WITH_SETTLEMENT_TIMEOUT_MS }, () => {
  it("is registered in PRODUCTION_TOOL_REGISTRY", () => {
    expect(PRODUCTION_TOOL_REGISTRY.get("crop_image")).toBe(cropImageTool);
  });

  it("generates an OpenRouter tool schema requiring only image_url", () => {
    const spec = toOpenRouterTools(PRODUCTION_TOOL_REGISTRY).find((s) => s.function.name === "crop_image");
    expect(spec).toBeDefined();
    expect(spec!.function.parameters).toMatchObject({ type: "object", required: ["image_url"] });
  });

  it("starts with nodeType crop_image and no subModelId, and completes with normalized output", async () => {
    const owner = await user("cropimg-happy-path");
    const { run } = await setUpRun(owner);
    const input = { image_url: "https://cdn.example.com/a.png", width_px: 500, height_px: 500 };
    const call = toolCall("crop_image", input);

    mockCallOpenRouter.mockResolvedValueOnce(toolRequest([call]));
    mockCallOpenRouter.mockResolvedValueOnce(finalAnswer("done"));
    mockStartMagicaRun.mockResolvedValueOnce({ runId: "magica_run_crop_1" });
    mockGetMagicaRun.mockResolvedValueOnce(pollResult({ status: "COMPLETED", output: { result: ["https://cdn.example.com/cropped.png"] } }));

    const result = await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([cropImageTool]), noopPublish);
    expect(result.status).toBe("COMPLETED");
    expect(mockStartMagicaRun).toHaveBeenCalledWith("crop_image", input, undefined);

    const invocation = await prisma.toolInvocation.findFirstOrThrow({ where: { agentRunId: run.id } });
    expect(invocation.status).toBe("COMPLETED");
    expect(invocation.output).toMatchObject({ images: ["https://cdn.example.com/cropped.png"] });
  });
});

describe("merge_videos — input validation (real discovered schema)", () => {
  it("accepts a minimal valid input (two video URLs)", () => {
    expect(
      mergeVideosTool.inputSchema.safeParse({
        video_urls: ["https://cdn.example.com/a.mp4", "https://cdn.example.com/b.mp4"],
      }).success,
    ).toBe(true);
  });

  it("accepts up to 100 video URLs", () => {
    const video_urls = Array.from({ length: 100 }, (_, i) => `https://cdn.example.com/${i}.mp4`);
    expect(mergeVideosTool.inputSchema.safeParse({ video_urls }).success).toBe(true);
  });

  it("rejects 101 video URLs", () => {
    const video_urls = Array.from({ length: 101 }, (_, i) => `https://cdn.example.com/${i}.mp4`);
    expect(mergeVideosTool.inputSchema.safeParse({ video_urls }).success).toBe(false);
  });

  it("rejects a single video URL — enforces the documented minimum of two in application validation", () => {
    expect(mergeVideosTool.inputSchema.safeParse({ video_urls: ["https://cdn.example.com/a.mp4"] }).success).toBe(false);
  });

  it("rejects an empty video_urls array", () => {
    expect(mergeVideosTool.inputSchema.safeParse({ video_urls: [] }).success).toBe(false);
  });

  it("rejects a non-HTTPS video URL", () => {
    expect(
      mergeVideosTool.inputSchema.safeParse({
        video_urls: ["http://cdn.example.com/a.mp4", "https://cdn.example.com/b.mp4"],
      }).success,
    ).toBe(false);
  });

  it("accepts an optional transition value", () => {
    expect(
      mergeVideosTool.inputSchema.safeParse({
        video_urls: ["https://cdn.example.com/a.mp4", "https://cdn.example.com/b.mp4"],
        transition: "fade",
      }).success,
    ).toBe(true);
  });

  it("rejects an unsupported transition value", () => {
    expect(
      mergeVideosTool.inputSchema.safeParse({
        video_urls: ["https://cdn.example.com/a.mp4", "https://cdn.example.com/b.mp4"],
        transition: "wipe",
      }).success,
    ).toBe(false);
  });

  it("does not accept an invented duration or codec field as part of the typed schema", () => {
    const parsed = mergeVideosTool.inputSchema.safeParse({
      video_urls: ["https://cdn.example.com/a.mp4", "https://cdn.example.com/b.mp4"],
      duration: 10,
    });
    // Zod's default object parsing strips unknown keys rather than
    // rejecting them; assert the unknown key never survives into the
    // parsed value, since no duration field is defined anywhere here.
    expect(parsed.success && !("duration" in parsed.data)).toBe(true);
  });
});

describe("merge_videos — registration and through the real agent loop", { timeout: AGENT_LOOP_WITH_SETTLEMENT_TIMEOUT_MS }, () => {
  it("is registered in PRODUCTION_TOOL_REGISTRY", () => {
    expect(PRODUCTION_TOOL_REGISTRY.get("merge_videos")).toBe(mergeVideosTool);
  });

  it("generates an OpenRouter tool schema requiring only video_urls", () => {
    const spec = toOpenRouterTools(PRODUCTION_TOOL_REGISTRY).find((s) => s.function.name === "merge_videos");
    expect(spec).toBeDefined();
    expect(spec!.function.parameters).toMatchObject({ type: "object", required: ["video_urls"] });
  });

  it("starts with nodeType merge_videos and no subModelId, and completes with normalized output", async () => {
    const owner = await user("mergevid-happy-path");
    const { run } = await setUpRun(owner);
    const input = { video_urls: ["https://cdn.example.com/a.mp4", "https://cdn.example.com/b.mp4"], transition: "fade" as const };
    const call = toolCall("merge_videos", input);

    mockCallOpenRouter.mockResolvedValueOnce(toolRequest([call]));
    mockCallOpenRouter.mockResolvedValueOnce(finalAnswer("done"));
    mockStartMagicaRun.mockResolvedValueOnce({ runId: "magica_run_merge_1" });
    mockGetMagicaRun.mockResolvedValueOnce(pollResult({ status: "COMPLETED", output: { result: ["https://cdn.example.com/merged.mp4"] } }));

    const result = await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([mergeVideosTool]), noopPublish);
    expect(result.status).toBe("COMPLETED");
    expect(mockStartMagicaRun).toHaveBeenCalledWith("merge_videos", input, undefined);

    const invocation = await prisma.toolInvocation.findFirstOrThrow({ where: { agentRunId: run.id } });
    expect(invocation.status).toBe("COMPLETED");
    expect(invocation.output).toMatchObject({ images: ["https://cdn.example.com/merged.mp4"] });
  });
});
