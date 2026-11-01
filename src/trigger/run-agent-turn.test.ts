import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/providers/openrouter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/providers/openrouter")>();
  return { ...actual, callOpenRouter: vi.fn() };
});

import { callOpenRouter, type ProviderToolCall } from "@/providers/openrouter";
import { prisma } from "@/lib/prisma";
import { makeTestUser, cleanupTestUsers } from "@/test-utils/db-fixtures";
import { createToolRegistry } from "@/tools/registry";
import { fixtureTool, fixtureToolWithReconcile, FIXTURE_TOOL_NAME } from "@/test-utils/fixture-tool";
import { executeAgentTurn } from "./run-agent-turn";

const mockCallOpenRouter = vi.mocked(callOpenRouter);
const createdUserIds: string[] = [];

function toolCall(name: string, args: Record<string, unknown> | string, id = randomUUID()): ProviderToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
  };
}

function finalAnswer(text: string) {
  return { model: "x/y:free", text, reasoning: null, toolCalls: null, promptTokens: 1, completionTokens: 1 };
}

function toolRequest(calls: ProviderToolCall[], text: string | null = null) {
  return { model: "x/y:free", text, reasoning: null, toolCalls: calls, promptTokens: 1, completionTokens: 1 };
}

beforeEach(() => mockCallOpenRouter.mockReset());
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
    data: {
      chatId: chat.id,
      userId: owner.id,
      agentRunId: run.id,
      role: "USER",
      status: "COMPLETE",
      content: [{ type: "text", text: "hello" }],
    },
  });
  return { chat, run };
}

describe("executeAgentTurn — success", () => {
  it("transitions PENDING -> COMPLETE, persists content and the actual routed model", async () => {
    const owner = await user("turn-success");
    const { chat, run } = await setUpRun(owner);
    mockCallOpenRouter.mockResolvedValueOnce({
      model: "nvidia/nemotron-3.5-super-vl:free",
      text: "pong",
      reasoning: "brief reasoning",
      toolCalls: null,
      promptTokens: 24,
      completionTokens: 49,
    });

    const result = await executeAgentTurn({ agentRunId: run.id });
    expect(result.status).toBe("COMPLETED");

    const updatedRun = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(updatedRun.status).toBe("COMPLETED");
    expect(updatedRun.model).toBe("nvidia/nemotron-3.5-super-vl:free");
    expect(updatedRun.promptTokens).toBe(24);
    expect(updatedRun.completionTokens).toBe(49);

    const assistantMsg = await prisma.message.findFirstOrThrow({
      where: { agentRunId: run.id, role: "ASSISTANT" },
    });
    expect(assistantMsg.status).toBe("COMPLETE");
    expect(assistantMsg.content).toEqual([
      { type: "thinking", text: "brief reasoning" },
      { type: "text", text: "pong" },
    ]);

    const updatedChat = await prisma.chat.findUniqueOrThrow({ where: { id: chat.id } });
    expect(updatedChat.lastMessageAt.getTime()).toBeGreaterThanOrEqual(
      assistantMsg.createdAt.getTime(),
    );

    expect(mockCallOpenRouter).toHaveBeenCalledTimes(1);
  });

  it("passes the prior user message as conversation context, excluding the new PENDING placeholder", async () => {
    const owner = await user("turn-context");
    const { run } = await setUpRun(owner);
    mockCallOpenRouter.mockResolvedValueOnce({
      model: "x/y:free",
      text: "ok",
      reasoning: null,
      toolCalls: null,
      promptTokens: 1,
      completionTokens: 1,
    });

    await executeAgentTurn({ agentRunId: run.id });

    const [context] = mockCallOpenRouter.mock.calls[0];
    expect(context).toEqual([{ role: "user", content: "hello" }]);
  });
});

describe("executeAgentTurn — definite failure", () => {
  it("marks the message FAILED and the run FAILED with the provider's error code", async () => {
    const owner = await user("turn-definite-fail");
    const { run } = await setUpRun(owner);
    const { OpenRouterDefiniteError } = await import("@/providers/openrouter");
    mockCallOpenRouter.mockRejectedValueOnce(
      new OpenRouterDefiniteError("Rate limit exceeded", "RATE_LIMITED"),
    );

    const result = await executeAgentTurn({ agentRunId: run.id });
    expect(result.status).toBe("FAILED");
    expect(result.ambiguous).toBe(false);

    const updatedRun = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(updatedRun.status).toBe("FAILED");
    expect(updatedRun.errorCode).toBe("RATE_LIMITED");

    const assistantMsg = await prisma.message.findFirstOrThrow({
      where: { agentRunId: run.id, role: "ASSISTANT" },
    });
    expect(assistantMsg.status).toBe("FAILED");
  });
});

describe("executeAgentTurn — ambiguous outcome and crash recovery", () => {
  it("a fresh ambiguous error (network/timeout) marks the run FAILED/AMBIGUOUS and leaves the message PENDING — not FAILED", async () => {
    const owner = await user("turn-ambiguous-fresh");
    const { run } = await setUpRun(owner);
    const { OpenRouterAmbiguousError } = await import("@/providers/openrouter");
    mockCallOpenRouter.mockRejectedValueOnce(new OpenRouterAmbiguousError("timed out"));

    const result = await executeAgentTurn({ agentRunId: run.id });
    expect(result.ambiguous).toBe(true);

    const updatedRun = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(updatedRun.status).toBe("FAILED");
    expect(updatedRun.errorCode).toBe("AMBIGUOUS_PROVIDER_OUTCOME");

    const assistantMsg = await prisma.message.findFirstOrThrow({
      where: { agentRunId: run.id, role: "ASSISTANT" },
    });
    expect(assistantMsg.status).toBe("PENDING"); // preserved as durable evidence, not flipped
    expect(assistantMsg.content).toEqual([]);
  });

  it(
    "re-entry after a simulated crash: a pre-existing PENDING message is detected, " +
      "NO second OpenRouter request is made, the run is marked AMBIGUOUS, the PENDING message is preserved",
    async () => {
      const owner = await user("turn-crash-reentry");
      const { run } = await setUpRun(owner);

      // Simulate the state a previous, crashed execution would have left:
      // it got as far as marking RUNNING and inserting the PENDING
      // assistant message (committed before calling OpenRouter), then
      // the process died before the call resolved — nothing else ran.
      await prisma.agentRun.update({
        where: { id: run.id },
        data: { status: "RUNNING", startedAt: new Date() },
      });
      const stalePending = await prisma.message.create({
        data: {
          chatId: run.chatId,
          userId: owner.id,
          agentRunId: run.id,
          role: "ASSISTANT",
          status: "PENDING",
          content: [],
        },
      });

      // Act: re-enter, exactly as a Trigger.dev retry or manual resume would.
      const result = await executeAgentTurn({ agentRunId: run.id });

      // The one guarantee that actually matters: no second request.
      expect(mockCallOpenRouter).not.toHaveBeenCalled();

      expect(result.ambiguous).toBe(true);
      const updatedRun = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(updatedRun.status).toBe("FAILED");
      expect(updatedRun.errorCode).toBe("AMBIGUOUS_PROVIDER_OUTCOME");

      const preservedMessage = await prisma.message.findUniqueOrThrow({
        where: { id: stalePending.id },
      });
      expect(preservedMessage.status).toBe("PENDING");
      expect(preservedMessage.content).toEqual([]);

      // Exactly one assistant message exists for this run — re-entry
      // reused the stale one as evidence, it didn't create another.
      const assistantCount = await prisma.message.count({
        where: { agentRunId: run.id, role: "ASSISTANT" },
      });
      expect(assistantCount).toBe(1);
    },
  );
});

describe("executeAgentTurn — terminal re-entry / duplicate dispatch", () => {
  it("a second invocation after COMPLETED is a no-op: no second call, no second message", async () => {
    const owner = await user("turn-duplicate");
    const { run } = await setUpRun(owner);
    mockCallOpenRouter.mockResolvedValueOnce({
      model: "x/y:free",
      text: "first",
      reasoning: null,
      toolCalls: null,
      promptTokens: 1,
      completionTokens: 1,
    });

    await executeAgentTurn({ agentRunId: run.id });
    const second = await executeAgentTurn({ agentRunId: run.id });

    expect(second.skipped).toBe(true);
    expect(mockCallOpenRouter).toHaveBeenCalledTimes(1);
    const assistantCount = await prisma.message.count({
      where: { agentRunId: run.id, role: "ASSISTANT" },
    });
    expect(assistantCount).toBe(1);
  });
});

// Checkpoint 2.3 — fixture-only tool-calling mechanism. The fixture tool
// is never registered into PRODUCTION_TOOL_REGISTRY; every test here
// injects its own registry via executeAgentTurn's `registry` parameter.
function spiedTool(base = fixtureTool) {
  const executeSpy = vi.fn(base.execute);
  return { tool: { ...base, execute: executeSpy }, executeSpy };
}

describe("executeAgentTurn — tool calling", () => {
  it("fixture tool round-trip: validates, persists before executing, executes, persists the result, feeds it back, and reaches a final answer", async () => {
    const owner = await user("tool-roundtrip");
    const { run } = await setUpRun(owner);
    const { tool, executeSpy } = spiedTool();
    const call = toolCall(FIXTURE_TOOL_NAME, { timezone: "UTC" });

    mockCallOpenRouter.mockResolvedValueOnce(toolRequest([call]));
    mockCallOpenRouter.mockResolvedValueOnce(finalAnswer("done"));

    const result = await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([tool]));
    expect(result.status).toBe("COMPLETED");
    expect(mockCallOpenRouter).toHaveBeenCalledTimes(2);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy).toHaveBeenCalledWith({ timezone: "UTC" }, { agentRunId: run.id, userId: owner.id });

    const invocation = await prisma.toolInvocation.findFirstOrThrow({
      where: { agentRunId: run.id },
    });
    expect(invocation.status).toBe("COMPLETED");
    expect(invocation.toolName).toBe(FIXTURE_TOOL_NAME);
    expect(invocation.durationMs).toBeGreaterThanOrEqual(0);
    expect(invocation.output).toMatchObject({ timezone: "UTC" });

    const assistantMsg = await prisma.message.findFirstOrThrow({
      where: { agentRunId: run.id, role: "ASSISTANT" },
    });
    expect(assistantMsg.status).toBe("COMPLETE");
    const blocks = assistantMsg.content as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(3); // tool_use, tool_result, final text
    expect(blocks[0]).toMatchObject({
      type: "tool_use",
      toolInvocationId: invocation.id,
      toolName: FIXTURE_TOOL_NAME,
      status: "COMPLETED",
    });
    expect(blocks[1]).toMatchObject({ type: "tool_result", toolInvocationId: invocation.id, error: null });
    expect(blocks[2]).toEqual({ type: "text", text: "done" });

    // The second model call was fed the tool result.
    const secondCallMessages = mockCallOpenRouter.mock.calls[1][0];
    expect(secondCallMessages.at(-1)).toMatchObject({ role: "tool", tool_call_id: call.id });

    const updatedRun = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(updatedRun.turnCount).toBe(2);
  });

  it("captures narration text that accompanies a tool call, not just the final answer", async () => {
    const owner = await user("tool-narration");
    const { run } = await setUpRun(owner);
    const { tool } = spiedTool();
    const call = toolCall(FIXTURE_TOOL_NAME, { timezone: "UTC" });

    mockCallOpenRouter.mockResolvedValueOnce(toolRequest([call], "Let me check that for you."));
    mockCallOpenRouter.mockResolvedValueOnce(finalAnswer("done"));

    await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([tool]));

    const assistantMsg = await prisma.message.findFirstOrThrow({
      where: { agentRunId: run.id, role: "ASSISTANT" },
    });
    const blocks = assistantMsg.content as Array<Record<string, unknown>>;
    expect(blocks[0]).toEqual({ type: "text", text: "Let me check that for you." });
  });

  it("invalid input (fails the tool's own Zod schema) fails without calling execute, and the loop continues with the error fed back", async () => {
    const owner = await user("tool-invalid-input");
    const { run } = await setUpRun(owner);
    const { tool, executeSpy } = spiedTool();
    const call = toolCall(FIXTURE_TOOL_NAME, { timezone: 123 }); // wrong type

    mockCallOpenRouter.mockResolvedValueOnce(toolRequest([call]));
    mockCallOpenRouter.mockResolvedValueOnce(finalAnswer("sorry, bad input"));

    const result = await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([tool]));
    expect(result.status).toBe("COMPLETED");
    expect(executeSpy).not.toHaveBeenCalled();

    const invocation = await prisma.toolInvocation.findFirstOrThrow({
      where: { agentRunId: run.id },
    });
    expect(invocation.status).toBe("FAILED");
    expect(invocation.errorCode).toBe("INVALID_INPUT");
    expect(invocation.output).toBeNull();
  });

  it("malformed (non-JSON) tool call arguments fail the same way, without crashing the turn", async () => {
    const owner = await user("tool-malformed-json");
    const { run } = await setUpRun(owner);
    const { tool, executeSpy } = spiedTool();
    const call = toolCall(FIXTURE_TOOL_NAME, "{not valid json");

    mockCallOpenRouter.mockResolvedValueOnce(toolRequest([call]));
    mockCallOpenRouter.mockResolvedValueOnce(finalAnswer("ok"));

    const result = await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([tool]));
    expect(result.status).toBe("COMPLETED");
    expect(executeSpy).not.toHaveBeenCalled();

    const invocation = await prisma.toolInvocation.findFirstOrThrow({
      where: { agentRunId: run.id },
    });
    expect(invocation.errorCode).toBe("MALFORMED_ARGUMENTS");
  });

  it("an unknown tool name still produces an auditable FAILED invocation and feeds an error back, instead of crashing", async () => {
    const owner = await user("tool-unknown");
    const { run } = await setUpRun(owner);
    const { tool } = spiedTool();
    const call = toolCall("not_a_real_tool", {});

    mockCallOpenRouter.mockResolvedValueOnce(toolRequest([call]));
    mockCallOpenRouter.mockResolvedValueOnce(finalAnswer("ok"));

    const result = await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([tool]));
    expect(result.status).toBe("COMPLETED");

    const invocation = await prisma.toolInvocation.findFirstOrThrow({
      where: { agentRunId: run.id },
    });
    expect(invocation.toolName).toBe("not_a_real_tool");
    expect(invocation.errorCode).toBe("UNKNOWN_TOOL");
  });

  it("a tool execution failure (execute() throws) is recorded as FAILED with the real error message, and the loop continues", async () => {
    const owner = await user("tool-exec-fail");
    const { run } = await setUpRun(owner);
    const { tool } = spiedTool();
    const call = toolCall(FIXTURE_TOOL_NAME, { simulateFailure: true });

    mockCallOpenRouter.mockResolvedValueOnce(toolRequest([call]));
    mockCallOpenRouter.mockResolvedValueOnce(finalAnswer("ok"));

    const result = await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([tool]));
    expect(result.status).toBe("COMPLETED");

    const invocation = await prisma.toolInvocation.findFirstOrThrow({
      where: { agentRunId: run.id },
    });
    expect(invocation.status).toBe("FAILED");
    expect(invocation.errorCode).toBe("EXECUTION_FAILED");
    expect(invocation.errorMessage).toBe("Simulated fixture tool failure");
    expect(invocation.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("duplicate dispatch after a completed tool-calling run does not re-execute the tool", async () => {
    const owner = await user("tool-duplicate-dispatch");
    const { run } = await setUpRun(owner);
    const { tool, executeSpy } = spiedTool();
    const call = toolCall(FIXTURE_TOOL_NAME, { timezone: "UTC" });

    mockCallOpenRouter.mockResolvedValueOnce(toolRequest([call]));
    mockCallOpenRouter.mockResolvedValueOnce(finalAnswer("done"));

    await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([tool]));
    const second = await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([tool]));

    expect(second.skipped).toBe(true);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    const invocationCount = await prisma.toolInvocation.count({ where: { agentRunId: run.id } });
    expect(invocationCount).toBe(1);
  });

  it("ToolInvocation.idempotencyKey is unique per (run, tool call id) — a defensive backstop against a duplicate insert", async () => {
    const owner = await user("tool-idempotency-key");
    const { run } = await setUpRun(owner);
    const key = `${run.id}:${randomUUID()}`;
    await prisma.toolInvocation.create({
      data: {
        agentRunId: run.id,
        toolName: FIXTURE_TOOL_NAME,
        idempotencyKey: key,
        input: {},
        status: "COMPLETED",
      },
    });

    await expect(
      prisma.toolInvocation.create({
        data: {
          agentRunId: run.id,
          toolName: FIXTURE_TOOL_NAME,
          idempotencyKey: key,
          input: {},
          status: "COMPLETED",
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("executeAgentTurn — tool re-entry and reconcile()", () => {
  it("re-entry with a RUNNING ToolInvocation whose tool has no reconcile() marks the run ambiguous without executing anything", async () => {
    const owner = await user("tool-reentry-no-reconcile");
    const { run } = await setUpRun(owner);
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "RUNNING", startedAt: new Date() },
    });
    await prisma.message.create({
      data: {
        chatId: run.chatId,
        userId: owner.id,
        agentRunId: run.id,
        role: "ASSISTANT",
        status: "PENDING",
        content: [],
      },
    });
    const staleInvocation = await prisma.toolInvocation.create({
      data: {
        agentRunId: run.id,
        toolName: FIXTURE_TOOL_NAME,
        idempotencyKey: randomUUID(),
        input: {},
        status: "RUNNING",
      },
    });

    const { tool, executeSpy } = spiedTool();
    const result = await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([tool]));

    expect(executeSpy).not.toHaveBeenCalled();
    expect(mockCallOpenRouter).not.toHaveBeenCalled();
    expect(result.ambiguous).toBe(true);

    const updatedRun = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(updatedRun.status).toBe("FAILED");
    expect(updatedRun.errorCode).toBe("AMBIGUOUS_PROVIDER_OUTCOME");

    const preservedInvocation = await prisma.toolInvocation.findUniqueOrThrow({
      where: { id: staleInvocation.id },
    });
    expect(preservedInvocation.status).toBe("RUNNING"); // left as evidence, not flipped
  });

  it("re-entry with a RUNNING ToolInvocation whose tool HAS reconcile() dispatches to reconcile(), not execute() — signature-level per PHASE2-PLAN.md", async () => {
    const owner = await user("tool-reentry-reconcile");
    const { run } = await setUpRun(owner);
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "RUNNING", startedAt: new Date() },
    });
    await prisma.message.create({
      data: {
        chatId: run.chatId,
        userId: owner.id,
        agentRunId: run.id,
        role: "ASSISTANT",
        status: "PENDING",
        content: [],
      },
    });
    const staleInvocation = await prisma.toolInvocation.create({
      data: {
        agentRunId: run.id,
        toolName: fixtureToolWithReconcile.name,
        idempotencyKey: randomUUID(),
        input: {},
        status: "RUNNING",
        providerRunId: "external-run-123",
      },
    });

    const reconcileSpy = vi.fn(fixtureToolWithReconcile.reconcile!);
    const executeSpy = vi.fn(fixtureToolWithReconcile.execute);
    const tool = { ...fixtureToolWithReconcile, reconcile: reconcileSpy, execute: executeSpy };

    const result = await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([tool]));

    expect(reconcileSpy).toHaveBeenCalledTimes(1);
    expect(reconcileSpy).toHaveBeenCalledWith({
      id: staleInvocation.id,
      providerRunId: "external-run-123",
    });
    expect(executeSpy).not.toHaveBeenCalled();
    expect(mockCallOpenRouter).not.toHaveBeenCalled();
    // Phase 2 has no real async tool to safely resume the loop against,
    // so even a resolved reconcile() still ends the run here — see
    // PHASE2-PLAN.md and run-agent-turn.ts's re-entry comment.
    expect(result.ambiguous).toBe(true);

    const updatedRun = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(updatedRun.status).toBe("FAILED");
  });
});

describe("executeAgentTurn — turn limit", () => {
  it("stops after the maximum number of turns if the model never produces a final answer, preserving partial content", async () => {
    const owner = await user("tool-turn-limit");
    const { run } = await setUpRun(owner);
    const { tool } = spiedTool();

    mockCallOpenRouter.mockImplementation(async () =>
      toolRequest([toolCall(FIXTURE_TOOL_NAME, { timezone: "UTC" })]),
    );

    const result = await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([tool]));
    expect(result.status).toBe("FAILED");
    expect(result.ambiguous).toBe(false);

    const updatedRun = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(updatedRun.errorCode).toBe("TURN_LIMIT_EXCEEDED");
    expect(updatedRun.turnCount).toBe(8);
    expect(mockCallOpenRouter).toHaveBeenCalledTimes(8);

    const assistantMsg = await prisma.message.findFirstOrThrow({
      where: { agentRunId: run.id, role: "ASSISTANT" },
    });
    expect(assistantMsg.status).toBe("FAILED");
    const blocks = assistantMsg.content as Array<Record<string, unknown>>;
    expect(blocks.length).toBe(16); // 8 rounds * (tool_use + tool_result), no final text block
    expect(blocks.every((b) => b.type === "tool_use" || b.type === "tool_result")).toBe(true);
  });
});
