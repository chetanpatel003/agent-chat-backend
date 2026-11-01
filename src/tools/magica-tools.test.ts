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

import { callOpenRouter, type ProviderToolCall } from "@/providers/openrouter";
import { startMagicaRun, getMagicaRun } from "@/providers/magica";
import { prisma } from "@/lib/prisma";
import { makeTestUser, cleanupTestUsers } from "@/test-utils/db-fixtures";
import { createToolRegistry, toOpenRouterTools, PRODUCTION_TOOL_REGISTRY } from "./registry";
import { generateImageTool } from "./magica-tools";
import { executeAgentTurn } from "@/trigger/run-agent-turn";
import type { PublishRunEvent } from "@/realtime/publish-run-event";

const mockCallOpenRouter = vi.mocked(callOpenRouter);
const mockStartMagicaRun = vi.mocked(startMagicaRun);
const mockGetMagicaRun = vi.mocked(getMagicaRun);
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
  return { model: "x/y:free", text, reasoning: null, toolCalls: null, promptTokens: 1, completionTokens: 1 };
}
function toolRequest(calls: ProviderToolCall[], text: string | null = null) {
  return { model: "x/y:free", text, reasoning: null, toolCalls: calls, promptTokens: 1, completionTokens: 1 };
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

describe("generate_image — through the real agent loop", () => {
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

  it("preserves the complete raw output even when no images array is present, without inventing one", async () => {
    const owner = await user("genimg-no-images-field");
    const { run } = await setUpRun(owner);
    const call = toolCall("generate_image", { prompt: "x" });

    mockCallOpenRouter.mockResolvedValueOnce(toolRequest([call]));
    mockCallOpenRouter.mockResolvedValueOnce(finalAnswer("done"));
    mockStartMagicaRun.mockResolvedValueOnce({ runId: "magica_run_img_2" });
    mockGetMagicaRun.mockResolvedValueOnce(pollResult({ status: "COMPLETED", output: { somethingElse: true } }));

    await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([generateImageTool]), noopPublish);

    const invocation = await prisma.toolInvocation.findFirstOrThrow({ where: { agentRunId: run.id } });
    expect(invocation.output).toEqual({ raw: { somethingElse: true } });
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

    // execute() threw a plain Error (not MagicaPollInconclusiveError),
    // so runOneToolCall's existing, already-established mechanism
    // persists it as an ordinary tool-execution failure — the same
    // outcome any other execute()-throws case gets.
    const invocation = await prisma.toolInvocation.findFirstOrThrow({ where: { agentRunId: run.id } });
    expect(invocation.status).toBe("FAILED");
    expect(invocation.errorCode).toBe("EXECUTION_FAILED");
    expect(invocation.providerRunId).toBeNull(); // the persistence write never landed
  });
});

describe("generate_image — reconciliation on re-entry", () => {
  it("a completed remote run discovered by reconcile() is persisted; never starts a second run", async () => {
    const owner = await user("genimg-reconcile-completed");
    const { chat, run } = await setUpRun(owner);
    await prisma.agentRun.update({ where: { id: run.id }, data: { status: "RUNNING", startedAt: new Date() } });
    await prisma.message.create({
      data: { chatId: chat.id, userId: owner.id, agentRunId: run.id, role: "ASSISTANT", status: "PENDING", content: [] },
    });
    const stale = await prisma.toolInvocation.create({
      data: { agentRunId: run.id, toolName: "generate_image", idempotencyKey: randomUUID(), input: {}, status: "RUNNING", providerRunId: "magica_run_reentry" },
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
