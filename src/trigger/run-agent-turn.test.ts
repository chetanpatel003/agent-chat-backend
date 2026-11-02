import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/providers/openrouter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/providers/openrouter")>();
  return { ...actual, callOpenRouter: vi.fn() };
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { callOpenRouter, type ProviderToolCall } from "@/providers/openrouter";
import { prisma } from "@/lib/prisma";
import { makeTestUser, cleanupTestUsers } from "@/test-utils/db-fixtures";
import { createToolRegistry } from "@/tools/registry";
import { fixtureTool, fixtureToolWithReconcile, FIXTURE_TOOL_NAME } from "@/test-utils/fixture-tool";
import type { PublishRunEvent } from "@/realtime/publish-run-event";
import { cancelRun } from "@/services/agent-run";
import { discoverSkills, buildSkillRegistry } from "@/skills/registry";
import type { SkillRegistry } from "@/skills/types";
import { createLoadSkillTool, createReadSkillAssetTool } from "@/tools/skills";
import { executeAgentTurn } from "./run-agent-turn";

const mockCallOpenRouter = vi.mocked(callOpenRouter);
const createdUserIds: string[] = [];

// Checkpoint 2.4: every call site below injects an explicit publisher
// rather than relying on the real default — the real one calls
// Trigger.dev's `metadata.append`, which throws "Method not
// implemented" outside a live task context (confirmed empirically,
// caught safely by publishRunEvent's own try/catch, but noisy and
// beside the point for tests that aren't exercising the publisher
// itself). Tests that *do* care about publishing inject their own spy.
const noopPublish: PublishRunEvent = vi.fn().mockResolvedValue(undefined);

function toolCall(name: string, args: Record<string, unknown> | string, id = randomUUID()): ProviderToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
  };
}

function finalAnswer(text: string) {
  return { model: "x/y:free", text, toolCalls: null, promptTokens: 1, completionTokens: 1 };
}

function toolRequest(calls: ProviderToolCall[], text: string | null = null) {
  return { model: "x/y:free", text, toolCalls: calls, promptTokens: 1, completionTokens: 1 };
}

beforeEach(() => mockCallOpenRouter.mockReset());
afterAll(() => cleanupTestUsers(createdUserIds));

const skillFixtureTmpDirs: string[] = [];
afterAll(() => {
  while (skillFixtureTmpDirs.length) fs.rmSync(skillFixtureTmpDirs.pop()!, { recursive: true, force: true });
});

/** A one-skill fixture registry built through the real discoverSkills()
 * walk, used by the integration tests below so they don't depend on
 * (or need to keep in sync with) the real agent-skills/ directory. */
function fixtureSkillRegistry(): SkillRegistry {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-agent-turn-skills-"));
  skillFixtureTmpDirs.push(root);
  const skillDir = path.join(root, "fixture-skill");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    skillDir + "/SKILL.md",
    "---\nname: fixture-skill\ndescription: A fixture skill for orchestration tests.\n---\nFixture instructions.\n",
  );
  return buildSkillRegistry(discoverSkills(root));
}

async function user(label: string) {
  const u = await makeTestUser(label);
  createdUserIds.push(u.id);
  return u;
}

/** Phase 3.1: simulates real wall-clock time having passed since an
 * AgentRun's last write — raw SQL, not a normal Prisma `update()`,
 * because `@updatedAt` always overrides an explicit value in `data`
 * with "now." Used to make a *genuinely* stale re-entry scenario
 * distinguishable, in tests, from a *just-written-moments-ago* one —
 * exactly the distinction `isAgentRunRecentlyActive` exists to draw. */
async function backdateAgentRunActivity(agentRunId: string, ageMs: number) {
  await prisma.$executeRaw`UPDATE "AgentRun" SET "updatedAt" = ${new Date(Date.now() - ageMs)} WHERE "id" = ${agentRunId}::uuid`;
}
const LONG_AGO_MS = 5 * 60_000; // well past STALE_RUN_LIVENESS_THRESHOLD_MS (120s)

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
    // A stray `reasoning` field (as if an adapter regressed and leaked it)
    // must still never reach persisted user-visible content.
    mockCallOpenRouter.mockResolvedValueOnce({
      model: "nvidia/nemotron-3.5-super-vl:free",
      text: "pong",
      reasoning: "brief reasoning",
      toolCalls: null,
      promptTokens: 24,
      completionTokens: 49,
    } as Awaited<ReturnType<typeof callOpenRouter>>);

    const result = await executeAgentTurn({ agentRunId: run.id }, undefined, noopPublish);
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
    expect(assistantMsg.content).toEqual([{ type: "text", text: "pong" }]);
    expect(JSON.stringify(assistantMsg.content)).not.toContain("brief reasoning");

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
      toolCalls: null,
      promptTokens: 1,
      completionTokens: 1,
    });

    await executeAgentTurn({ agentRunId: run.id }, undefined, noopPublish);

    const [context] = mockCallOpenRouter.mock.calls[0];
    // Checkpoint 2.5: a synthesized skill system prompt is now always
    // prepended — asserted precisely in run-agent-turn.test.ts's own
    // "skill system prompt" describe block below; here just confirm it
    // doesn't disturb the real conversation history that follows it.
    expect(context).toHaveLength(2);
    expect(context[0]).toMatchObject({ role: "system" });
    expect(context.at(-1)).toEqual({ role: "user", content: "hello" });
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

    const result = await executeAgentTurn({ agentRunId: run.id }, undefined, noopPublish);
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

    const result = await executeAgentTurn({ agentRunId: run.id }, undefined, noopPublish);
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
      // Genuinely old — a real crash, not a sibling moments into its
      // own legitimate work (see isAgentRunRecentlyActive, Phase 3.1).
      await backdateAgentRunActivity(run.id, LONG_AGO_MS);

      // Act: re-enter, exactly as a Trigger.dev retry or manual resume would.
      const result = await executeAgentTurn({ agentRunId: run.id }, undefined, noopPublish);

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
      toolCalls: null,
      promptTokens: 1,
      completionTokens: 1,
    });

    await executeAgentTurn({ agentRunId: run.id }, undefined, noopPublish);
    const second = await executeAgentTurn({ agentRunId: run.id }, undefined, noopPublish);

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

    const result = await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([tool]), noopPublish);
    expect(result.status).toBe("COMPLETED");
    expect(mockCallOpenRouter).toHaveBeenCalledTimes(2);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    const invocation = await prisma.toolInvocation.findFirstOrThrow({
      where: { agentRunId: run.id },
    });
    // Checkpoint 3.2: the already-created invocation's own id is now
    // propagated into the execution context — asserted against the
    // real persisted row's id, not just `expect.any(String)`.
    expect(executeSpy).toHaveBeenCalledWith(
      { timezone: "UTC" },
      { agentRunId: run.id, userId: owner.id, invocationId: invocation.id },
    );
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

    await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([tool]), noopPublish);

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

    const result = await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([tool]), noopPublish);
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

    const result = await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([tool]), noopPublish);
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

    const result = await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([tool]), noopPublish);
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

    const result = await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([tool]), noopPublish);
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

    await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([tool]), noopPublish);
    const second = await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([tool]), noopPublish);

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
    await backdateAgentRunActivity(run.id, LONG_AGO_MS);

    const { tool, executeSpy } = spiedTool();
    const result = await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([tool]), noopPublish);

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
    await backdateAgentRunActivity(run.id, LONG_AGO_MS);

    const reconcileSpy = vi.fn(fixtureToolWithReconcile.reconcile!);
    const executeSpy = vi.fn(fixtureToolWithReconcile.execute);
    const tool = { ...fixtureToolWithReconcile, reconcile: reconcileSpy, execute: executeSpy };

    const result = await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([tool]), noopPublish);

    expect(reconcileSpy).toHaveBeenCalledTimes(1);
    expect(reconcileSpy).toHaveBeenCalledWith({
      id: staleInvocation.id,
      providerRunId: "external-run-123",
    });
    expect(executeSpy).not.toHaveBeenCalled();
    expect(mockCallOpenRouter).not.toHaveBeenCalled();
    // Phase 2 has no real async tool to safely resume the loop against,
    // so even a resolved reconcile() still ends the *run* ambiguous
    // here — see PHASE2-PLAN.md and run-agent-turn.ts's re-entry
    // comment. Checkpoint 3.2: the *ToolInvocation* itself is no
    // longer left stranded RUNNING, though — its genuinely-completed
    // result (from fixtureToolWithReconcile.reconcile()) is now
    // captured and persisted, not discarded.
    expect(result.ambiguous).toBe(true);

    const updatedRun = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(updatedRun.status).toBe("FAILED");

    const updatedInvocation = await prisma.toolInvocation.findUniqueOrThrow({ where: { id: staleInvocation.id } });
    expect(updatedInvocation.status).toBe("COMPLETED");
    expect(updatedInvocation.output).toEqual({ isoTime: "2026-01-01T00:00:00.000Z", timezone: "UTC" });
  });
});

// Phase 3.1 — the concurrency race documented in checkpoint 2.4
// (API_CONTRACTS.md's "known, accepted trade-off") investigated
// further, per this checkpoint's explicit instruction not to assume
// Trigger.dev idempotency makes it impossible without evidence. Fixed
// with `isAgentRunRecentlyActive` (src/services/run-transitions.ts),
// not a new framework — see its own doc comment for why `updatedAt`,
// already bumped every round, is a sufficient liveness signal.
describe("executeAgentTurn — liveness-guarded re-entry (Phase 3.1)", () => {
  it("a PENDING message that was written moments ago is NOT treated as stale — backs off instead of marking the run ambiguous", async () => {
    const owner = await user("liveness-pending-fresh");
    const { run } = await setUpRun(owner);
    await prisma.agentRun.update({ where: { id: run.id }, data: { status: "RUNNING", startedAt: new Date() } });
    await prisma.message.create({
      data: { chatId: run.chatId, userId: owner.id, agentRunId: run.id, role: "ASSISTANT", status: "PENDING", content: [] },
    });
    // No backdating — this row's updatedAt is from the setup above,
    // moments ago, exactly like a sibling genuinely still working.

    const result = await executeAgentTurn({ agentRunId: run.id }, undefined, noopPublish);

    expect(result).toEqual({ status: "RUNNING", skipped: true, ambiguous: false });
    expect(mockCallOpenRouter).not.toHaveBeenCalled();
    const updatedRun = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(updatedRun.status).toBe("RUNNING"); // nothing was written
    expect(updatedRun.errorCode).toBeNull();
  });

  it("a RUNNING ToolInvocation from moments ago is NOT treated as stale — backs off instead of calling reconcile() or marking ambiguous", async () => {
    const owner = await user("liveness-invocation-fresh");
    const { run } = await setUpRun(owner);
    await prisma.agentRun.update({ where: { id: run.id }, data: { status: "RUNNING", startedAt: new Date() } });
    await prisma.message.create({
      data: { chatId: run.chatId, userId: owner.id, agentRunId: run.id, role: "ASSISTANT", status: "PENDING", content: [] },
    });
    await prisma.toolInvocation.create({
      data: { agentRunId: run.id, toolName: FIXTURE_TOOL_NAME, idempotencyKey: randomUUID(), input: {}, status: "RUNNING" },
    });
    // No backdating, same reason as above.

    const { tool, executeSpy } = spiedTool();
    const result = await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([tool]), noopPublish);

    expect(result).toEqual({ status: "RUNNING", skipped: true, ambiguous: false });
    expect(executeSpy).not.toHaveBeenCalled();
    expect(mockCallOpenRouter).not.toHaveBeenCalled();
    const updatedRun = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(updatedRun.status).toBe("RUNNING");
  });

  it("once genuinely stale (old), the exact same scenario still resolves to ambiguous — the fix narrows the window, it doesn't remove crash recovery", async () => {
    const owner = await user("liveness-pending-then-stale");
    const { run } = await setUpRun(owner);
    await prisma.agentRun.update({ where: { id: run.id }, data: { status: "RUNNING", startedAt: new Date() } });
    await prisma.message.create({
      data: { chatId: run.chatId, userId: owner.id, agentRunId: run.id, role: "ASSISTANT", status: "PENDING", content: [] },
    });
    await backdateAgentRunActivity(run.id, LONG_AGO_MS);

    const result = await executeAgentTurn({ agentRunId: run.id }, undefined, noopPublish);

    expect(result.ambiguous).toBe(true);
    const updatedRun = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(updatedRun.status).toBe("FAILED");
    expect(updatedRun.errorCode).toBe("AMBIGUOUS_PROVIDER_OUTCOME");
  });

  it(
    "reproduces the original race deterministically: two truly concurrent executions now always let the " +
      "winner complete — the loser backs off instead of marking the run ambiguous out from under it",
    async () => {
      const owner = await user("liveness-race-reproduction");
      const { run } = await setUpRun(owner);

      // Same construction as the checkpoint 2.4 concurrency test: a
      // real delay forces genuine overlap between the two executions.
      mockCallOpenRouter.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(finalAnswer("done")), 30)),
      );

      const [resultA, resultB] = await Promise.all([
        executeAgentTurn({ agentRunId: run.id }, undefined, noopPublish),
        executeAgentTurn({ agentRunId: run.id }, undefined, noopPublish),
      ]);

      expect(mockCallOpenRouter).toHaveBeenCalledTimes(1);
      const updatedRun = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
      // Before this fix, this could resolve to FAILED/AMBIGUOUS — the
      // loser's stale-message check could fire before the winner's own
      // provider call resolved. Now: the loser sees the winner's
      // AgentRun.updatedAt is fresh (bumped by the CAS-to-RUNNING or the
      // turnCount write moments ago) and backs off instead, every time —
      // the run itself always ends up COMPLETED.
      expect(updatedRun.status).toBe("COMPLETED");

      // The loser backs off via one of two safe paths (the liveness-
      // guarded stale-message check, or losing the message-insert race
      // outright) — either way its reported status is a snapshot at
      // that instant, not a prediction of the winner's eventual
      // outcome, so it is not pinned to one exact value here.
      const winner = [resultA, resultB].find((r) => !r.skipped)!;
      const loser = [resultA, resultB].find((r) => r.skipped)!;
      expect(winner.status).toBe("COMPLETED");
      expect(loser.ambiguous).toBe(false);
      expect(["RUNNING", "COMPLETED"]).toContain(loser.status);

      const assistantCount = await prisma.message.count({ where: { agentRunId: run.id, role: "ASSISTANT" } });
      expect(assistantCount).toBe(1);
    },
  );
});

describe("executeAgentTurn — turn limit", () => {
  it("stops after the maximum number of turns if the model never produces a final answer, preserving partial content", async () => {
    // Checkpoint 2.4 added guarded status reads before/after each round
    // and before each tool call — real round trips to Neon, not free —
    // so 8 full rounds genuinely needs more than the global 20s budget.
    const owner = await user("tool-turn-limit");
    const { run } = await setUpRun(owner);
    const { tool, executeSpy } = spiedTool();

    mockCallOpenRouter.mockImplementation(async () =>
      toolRequest([toolCall(FIXTURE_TOOL_NAME, { timezone: "UTC" })]),
    );

    const result = await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([tool]), noopPublish);
    expect(result.status).toBe("FAILED");
    expect(result.ambiguous).toBe(false);

    const updatedRun = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(updatedRun.errorCode).toBe("TURN_LIMIT_EXCEEDED");
    expect(updatedRun.turnCount).toBe(8);
    expect(mockCallOpenRouter).toHaveBeenCalledTimes(8);

    // Phase 3.1: the model is still called all 8 times (round 8 might
    // have produced a final answer instead of another tool request),
    // but its round-8 tool request is never executed — only rounds 1-7.
    expect(executeSpy).toHaveBeenCalledTimes(7);

    const assistantMsg = await prisma.message.findFirstOrThrow({
      where: { agentRunId: run.id, role: "ASSISTANT" },
    });
    expect(assistantMsg.status).toBe("FAILED");
    const blocks = assistantMsg.content as Array<Record<string, unknown>>;
    expect(blocks.length).toBe(16); // 8 rounds * (tool_use + tool_result), no final text block
    expect(blocks.every((b) => b.type === "tool_use" || b.type === "tool_result")).toBe(true);

    const invocations = await prisma.toolInvocation.findMany({
      where: { agentRunId: run.id },
      orderBy: { createdAt: "asc" },
    });
    expect(invocations).toHaveLength(8);
    expect(invocations.slice(0, 7).every((i) => i.status === "COMPLETED")).toBe(true);
    expect(invocations[7].status).toBe("CANCELLED");
    expect(invocations[7].errorCode).toBe("TURN_LIMIT_EXCEEDED");
  }, 40000);

  it("the final round's tool request is still cancelled correctly when the model requests more than one tool call at once", async () => {
    const owner = await user("tool-turn-limit-multi");
    const { run } = await setUpRun(owner);
    const { tool } = spiedTool();

    mockCallOpenRouter.mockImplementation(async () =>
      toolRequest([toolCall(FIXTURE_TOOL_NAME, { timezone: "UTC" }), toolCall(FIXTURE_TOOL_NAME, { timezone: "PST" })]),
    );

    const result = await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([tool]), noopPublish);
    expect(result.status).toBe("FAILED");

    const invocations = await prisma.toolInvocation.findMany({
      where: { agentRunId: run.id, status: "CANCELLED" },
    });
    // Round 8 requested two calls; both must be recorded cancelled —
    // "do not silently discard tool results" applies to every one of
    // them, not just the first.
    expect(invocations).toHaveLength(2);
    expect(invocations.every((i) => i.errorCode === "TURN_LIMIT_EXCEEDED")).toBe(true);
  }, 40000);

  it("a final answer (no tool calls) on the last permitted round still succeeds normally — the fix doesn't also block success", async () => {
    const owner = await user("tool-turn-limit-boundary-success");
    const { run } = await setUpRun(owner);
    const { tool } = spiedTool();

    // Rounds 1-7 request a tool; round 8 (the last) produces a final answer.
    mockCallOpenRouter
      .mockResolvedValueOnce(toolRequest([toolCall(FIXTURE_TOOL_NAME, { timezone: "UTC" })]))
      .mockResolvedValueOnce(toolRequest([toolCall(FIXTURE_TOOL_NAME, { timezone: "UTC" })]))
      .mockResolvedValueOnce(toolRequest([toolCall(FIXTURE_TOOL_NAME, { timezone: "UTC" })]))
      .mockResolvedValueOnce(toolRequest([toolCall(FIXTURE_TOOL_NAME, { timezone: "UTC" })]))
      .mockResolvedValueOnce(toolRequest([toolCall(FIXTURE_TOOL_NAME, { timezone: "UTC" })]))
      .mockResolvedValueOnce(toolRequest([toolCall(FIXTURE_TOOL_NAME, { timezone: "UTC" })]))
      .mockResolvedValueOnce(toolRequest([toolCall(FIXTURE_TOOL_NAME, { timezone: "UTC" })]))
      .mockResolvedValueOnce(finalAnswer("done on the last round"));

    const result = await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([tool]), noopPublish);

    expect(result.status).toBe("COMPLETED");
    const updatedRun = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(updatedRun.turnCount).toBe(8);
    expect(await prisma.toolInvocation.count({ where: { agentRunId: run.id, status: "CANCELLED" } })).toBe(0);
  }, 40000);
});

// Checkpoint 2.4 — guarded CAS transitions, atomic terminal writes, the
// one-assistant-message-per-run index as a real concurrency mutex,
// cancellation, and realtime publishing. See
// project-docs/API_CONTRACTS.md for the full mechanism.

describe("executeAgentTurn — concurrent duplicate execution", () => {
  it(
    "two concurrent executions for the same run produce exactly one assistant message, exactly one " +
      "provider call, and a single consistent terminal outcome both executions agree on",
    async () => {
      const owner = await user("concurrent-dup");
      const { run } = await setUpRun(owner);

      // A real delay forces genuine overlap between the two executions —
      // without it, nothing guarantees they actually race rather than one
      // completing before the other starts.
      mockCallOpenRouter.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(finalAnswer("done")), 30)),
      );

      const [resultA, resultB] = await Promise.all([
        executeAgentTurn({ agentRunId: run.id }, undefined, noopPublish),
        executeAgentTurn({ agentRunId: run.id }, undefined, noopPublish),
      ]);

      // The real mutex is the partial unique index on Message(agentRunId)
      // WHERE role='ASSISTANT' — both executions can pass every read-check
      // above (neither has inserted anything yet), but only one insert can
      // ever succeed; the loser's P2002 exits it immediately, before it
      // ever reaches the provider call.
      expect(mockCallOpenRouter).toHaveBeenCalledTimes(1);

      const assistantCount = await prisma.message.count({
        where: { agentRunId: run.id, role: "ASSISTANT" },
      });
      expect(assistantCount).toBe(1);

      // Phase 3.1: this used to be a genuine, narrow race — the "loser"
      // could discover the "winner's" still-PENDING message via the
      // stale-message re-entry check *before* the winner's own provider
      // call resolved, and mark the run FAILED/AMBIGUOUS_PROVIDER_OUTCOME,
      // pre-empting an otherwise-successful completion (never corrupting
      // anything — the winner's own guarded finalize transaction would
      // correctly back off — but discarding a perfectly good answer).
      // `isAgentRunRecentlyActive` (src/services/run-transitions.ts)
      // closes this: the loser now sees the winner's AgentRun.updatedAt
      // is fresh and backs off instead, deterministically, every run.
      // See the dedicated regression test in the "liveness-guarded
      // re-entry" describe block below, which reproduces this exact
      // scenario and asserts the fix directly; kept here too so this
      // pre-existing test's own coverage isn't reduced.
      const updatedRun = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(updatedRun.status).toBe("COMPLETED");

      // The execution that actually did the work must agree with the
      // database. The one that deferred backs off via one of two safe
      // paths — the liveness-guarded stale-message check (reports
      // "RUNNING," its accurate snapshot at that instant) or losing the
      // message-insert race outright (reports whatever the row's
      // current status is by then, which can itself already be
      // "COMPLETED" depending on exact interleaving) — so its status
      // is not pinned to one value, but it must never claim a *wrong*
      // final state, and it must never be the one that did real work.
      const winner = [resultA, resultB].find((r) => !r.skipped)!;
      const loser = [resultA, resultB].find((r) => r.skipped)!;
      expect(winner.status).toBe(updatedRun.status);
      expect(loser.ambiguous).toBe(false);
      expect(["RUNNING", "COMPLETED"]).toContain(loser.status);
    },
  );
});

describe("executeAgentTurn — cancellation", () => {
  it("cancelling a QUEUED run causes the worker to skip without calling OpenRouter", async () => {
    const owner = await user("cancel-while-queued");
    const { chat, run } = await setUpRun(owner);

    const cancelled = await cancelRun(owner.id, chat.id, run.id);
    expect(cancelled.status).toBe("CANCELLED");

    const result = await executeAgentTurn({ agentRunId: run.id }, undefined, noopPublish);
    expect(result.skipped).toBe(true);
    expect(result.status).toBe("CANCELLED");
    expect(mockCallOpenRouter).not.toHaveBeenCalled();
  });

  it(
    "cancelling while the provider call is active ends in CANCELLED (not a completion or an " +
      "ambiguous failure), preserves content from an earlier completed round, and never executes " +
      "the tool the delayed response would otherwise have requested",
    async () => {
      const owner = await user("cancel-mid-call");
      const { chat, run } = await setUpRun(owner);
      const { tool, executeSpy } = spiedTool();

      let callCount = 0;
      let releaseSecondCall: ((value: ReturnType<typeof toolRequest>) => void) | undefined;
      mockCallOpenRouter.mockImplementation(() => {
        callCount += 1;
        if (callCount === 1) {
          // Round 1 completes normally, producing real, persisted content.
          return Promise.resolve(toolRequest([toolCall(FIXTURE_TOOL_NAME, { timezone: "UTC" })]));
        }
        // Round 2 is held open until the test explicitly releases it —
        // this is the call the cancellation needs to land "during."
        return new Promise<ReturnType<typeof toolRequest>>((resolve) => {
          releaseSecondCall = resolve;
        });
      });

      const execution = executeAgentTurn({ agentRunId: run.id }, createToolRegistry([tool]), noopPublish);

      // Manual poll, not vi.waitFor: checkpoint 2.4 added several
      // guarded status reads per round, each a real round trip to
      // Neon, so reaching round 2's provider call takes a few seconds.
      for (let i = 0; i < 200 && callCount < 2; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(callCount).toBe(2);
      executeSpy.mockClear(); // only care about calls *after* this point

      const cancelled = await cancelRun(owner.id, chat.id, run.id);
      expect(cancelled.status).toBe("CANCELLED");

      // Released only now — a second tool call this response would
      // otherwise trigger must never actually run.
      releaseSecondCall?.(toolRequest([toolCall(FIXTURE_TOOL_NAME, { timezone: "UTC" })]));
      const result = await execution;

      expect(result.skipped).toBe(true);
      expect(result.status).toBe("CANCELLED");
      expect(executeSpy).not.toHaveBeenCalled();

      const updatedRun = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(updatedRun.status).toBe("CANCELLED");
      expect(updatedRun.errorCode).toBe("CANCELLED_BY_USER");

      const assistantMsg = await prisma.message.findFirstOrThrow({
        where: { agentRunId: run.id, role: "ASSISTANT" },
      });
      expect(assistantMsg.status).toBe("CANCELLED");
      const blocks = assistantMsg.content as Array<Record<string, unknown>>;
      // Round 1's tool_use + tool_result — preserved exactly, not erased
      // or overwritten by the cancellation.
      expect(blocks.length).toBe(2);
      expect(blocks[0].type).toBe("tool_use");
      expect(blocks[1].type).toBe("tool_result");

      // Only round 1's invocation exists — round 2 never started.
      const invocationCount = await prisma.toolInvocation.count({ where: { agentRunId: run.id } });
      expect(invocationCount).toBe(1);
    },
    60000,
  );

  it("cancelling an already-terminal (COMPLETED) run returns it unchanged — no second cancellation write", async () => {
    const owner = await user("cancel-already-completed");
    const { chat, run } = await setUpRun(owner);
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "COMPLETED", completedAt: new Date() },
    });

    const result = await cancelRun(owner.id, chat.id, run.id);
    expect(result.status).toBe("COMPLETED");
    expect(result.errorCode).toBeNull();
  });
});

describe("executeAgentTurn — realtime publishing (publish-after-commit)", () => {
  it("publishes run_status/assistant_message only after the corresponding database write has committed", async () => {
    const owner = await user("publish-after-commit");
    const { run } = await setUpRun(owner);
    mockCallOpenRouter.mockResolvedValueOnce(finalAnswer("done"));

    const seen: Array<{ type: string; agentRunStatus: string; messageStatus: string | null }> = [];
    const publish: PublishRunEvent = vi.fn(async (event) => {
      const [agentRun, message] = await Promise.all([
        prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } }),
        prisma.message.findFirst({ where: { agentRunId: run.id, role: "ASSISTANT" } }),
      ]);
      seen.push({
        type: event.type,
        agentRunStatus: agentRun.status,
        messageStatus: message?.status ?? null,
      });
    });

    await executeAgentTurn({ agentRunId: run.id }, undefined, publish);

    expect(seen.map((s) => s.type)).toEqual(["run_status", "assistant_message", "run_status"]);
    expect(seen[0].agentRunStatus).toBe("RUNNING");
    expect(seen[1].agentRunStatus).toBe("COMPLETED");
    expect(seen[1].messageStatus).toBe("COMPLETE");
    expect(seen[2].agentRunStatus).toBe("COMPLETED");
  });

  it("publishes tool_started/tool_completed only after the corresponding ToolInvocation write has committed", async () => {
    const owner = await user("publish-tool-after-commit");
    const { run } = await setUpRun(owner);
    const { tool } = spiedTool();
    const call = toolCall(FIXTURE_TOOL_NAME, { timezone: "UTC" });

    mockCallOpenRouter.mockResolvedValueOnce(toolRequest([call]));
    mockCallOpenRouter.mockResolvedValueOnce(finalAnswer("done"));

    const seenToolStatus: Record<string, string> = {};
    const publish: PublishRunEvent = vi.fn(async (event) => {
      if (event.type === "tool_started" || event.type === "tool_completed") {
        const invocation = await prisma.toolInvocation.findUniqueOrThrow({
          where: { id: event.toolInvocationId },
        });
        seenToolStatus[event.type] = invocation.status;
      }
    });

    await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([tool]), publish);

    expect(seenToolStatus.tool_started).toBe("RUNNING");
    expect(seenToolStatus.tool_completed).toBe("COMPLETED");
  });
});

describe("executeAgentTurn — realtime publisher failure isolation", () => {
  it("a publisher that throws synchronously on every call never interrupts the run", async () => {
    const owner = await user("publisher-always-throws");
    const { run } = await setUpRun(owner);
    mockCallOpenRouter.mockResolvedValueOnce(finalAnswer("done"));

    const throwingPublish: PublishRunEvent = vi.fn(() => {
      throw new Error("publisher is broken");
    });

    const result = await executeAgentTurn({ agentRunId: run.id }, undefined, throwingPublish);
    expect(result.status).toBe("COMPLETED");

    const updatedRun = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(updatedRun.status).toBe("COMPLETED");
    const assistantMsg = await prisma.message.findFirstOrThrow({
      where: { agentRunId: run.id, role: "ASSISTANT" },
    });
    expect(assistantMsg.status).toBe("COMPLETE");
    expect(throwingPublish).toHaveBeenCalled();
  });

  it("a publisher that rejects asynchronously on every call is isolated the same way", async () => {
    const owner = await user("publisher-rejects-async");
    const { run } = await setUpRun(owner);
    mockCallOpenRouter.mockResolvedValueOnce(finalAnswer("done"));

    const rejectingPublish: PublishRunEvent = vi.fn().mockRejectedValue(new Error("network blip"));

    const result = await executeAgentTurn({ agentRunId: run.id }, undefined, rejectingPublish);
    expect(result.status).toBe("COMPLETED");
  });
});

describe("executeAgentTurn — terminal-state protection", () => {
  it.each(["COMPLETED", "FAILED", "CANCELLED"] as const)(
    "a run already %s accepts no further writes, publishes nothing, and never calls OpenRouter",
    async (status) => {
      const owner = await user(`terminal-${status.toLowerCase()}`);
      const { run } = await setUpRun(owner);
      await prisma.agentRun.update({
        where: { id: run.id },
        data: { status, completedAt: new Date() },
      });
      const before = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });

      const publish: PublishRunEvent = vi.fn();
      const result = await executeAgentTurn({ agentRunId: run.id }, undefined, publish);

      expect(result).toEqual({ status, skipped: true, ambiguous: false });
      expect(mockCallOpenRouter).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();

      const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(after.updatedAt).toEqual(before.updatedAt);
      const assistantCount = await prisma.message.count({
        where: { agentRunId: run.id, role: "ASSISTANT" },
      });
      expect(assistantCount).toBe(0);
    },
  );
});

describe("executeAgentTurn — skill system prompt", () => {
  it("prepends a system message advertising every registered skill's name and description", async () => {
    const owner = await user("skill-prompt-contents");
    const { run } = await setUpRun(owner);
    mockCallOpenRouter.mockResolvedValueOnce(finalAnswer("done"));

    await executeAgentTurn({ agentRunId: run.id }, undefined, noopPublish, fixtureSkillRegistry());

    const [context] = mockCallOpenRouter.mock.calls[0];
    expect(context[0].role).toBe("system");
    expect((context[0] as { content: string }).content).toContain(
      "fixture-skill: A fixture skill for orchestration tests.",
    );
    // The base prompt must never carry a skill's full instructions.
    expect((context[0] as { content: string }).content).not.toContain("Fixture instructions.");
  });

  it("an unrelated skill is never auto-loaded just because it's registered", async () => {
    const owner = await user("skill-prompt-no-autoload");
    const { run } = await setUpRun(owner);
    mockCallOpenRouter.mockResolvedValueOnce(finalAnswer("done"));

    await executeAgentTurn({ agentRunId: run.id }, undefined, noopPublish, fixtureSkillRegistry());

    expect(await prisma.runSkill.count({ where: { agentRunId: run.id } })).toBe(0);
  });
});

describe("executeAgentTurn — skill tool integration", () => {
  it("a model-requested load_skill call persists a ToolInvocation and a RunSkill row through the real loop", async () => {
    const owner = await user("skill-tool-load");
    const { run } = await setUpRun(owner);
    const skillRegistry = fixtureSkillRegistry();
    const registry = createToolRegistry([createLoadSkillTool(skillRegistry), createReadSkillAssetTool(skillRegistry)]);
    const call = toolCall("load_skill", { name: "fixture-skill" });

    mockCallOpenRouter.mockResolvedValueOnce(toolRequest([call]));
    mockCallOpenRouter.mockResolvedValueOnce(finalAnswer("done"));

    const result = await executeAgentTurn({ agentRunId: run.id }, registry, noopPublish, skillRegistry);
    expect(result.status).toBe("COMPLETED");

    const invocation = await prisma.toolInvocation.findFirstOrThrow({
      where: { agentRunId: run.id, toolName: "load_skill" },
    });
    expect(invocation.status).toBe("COMPLETED");
    expect((invocation.output as { contentHash: string }).contentHash).toMatch(/^[a-f0-9]{64}$/);

    const runSkill = await prisma.runSkill.findFirstOrThrow({ where: { agentRunId: run.id } });
    expect(runSkill.skillName).toBe("fixture-skill");
  });

  it("an invalid load_skill call (missing the required name field) fails safely through the existing Zod boundary, never touching RunSkill", async () => {
    const owner = await user("skill-tool-invalid-input");
    const { run } = await setUpRun(owner);
    const skillRegistry = fixtureSkillRegistry();
    const registry = createToolRegistry([createLoadSkillTool(skillRegistry), createReadSkillAssetTool(skillRegistry)]);
    const call = toolCall("load_skill", {});

    mockCallOpenRouter.mockResolvedValueOnce(toolRequest([call]));
    mockCallOpenRouter.mockResolvedValueOnce(finalAnswer("done"));

    const result = await executeAgentTurn({ agentRunId: run.id }, registry, noopPublish, skillRegistry);
    expect(result.status).toBe("COMPLETED");

    const invocation = await prisma.toolInvocation.findFirstOrThrow({
      where: { agentRunId: run.id, toolName: "load_skill" },
    });
    expect(invocation.status).toBe("FAILED");
    expect(invocation.errorCode).toBe("INVALID_INPUT");
    expect(await prisma.runSkill.count({ where: { agentRunId: run.id } })).toBe(0);
  });

  it("an unknown-skill load_skill call fails safely as an ordinary tool execution failure, same mechanism as any other tool error", async () => {
    const owner = await user("skill-tool-unknown-skill");
    const { run } = await setUpRun(owner);
    const skillRegistry = fixtureSkillRegistry();
    const registry = createToolRegistry([createLoadSkillTool(skillRegistry), createReadSkillAssetTool(skillRegistry)]);
    const call = toolCall("load_skill", { name: "no-such-skill" });

    mockCallOpenRouter.mockResolvedValueOnce(toolRequest([call]));
    mockCallOpenRouter.mockResolvedValueOnce(finalAnswer("done"));

    const result = await executeAgentTurn({ agentRunId: run.id }, registry, noopPublish, skillRegistry);
    expect(result.status).toBe("COMPLETED");

    const invocation = await prisma.toolInvocation.findFirstOrThrow({
      where: { agentRunId: run.id, toolName: "load_skill" },
    });
    expect(invocation.status).toBe("FAILED");
    expect(invocation.errorCode).toBe("EXECUTION_FAILED");
  });
});
