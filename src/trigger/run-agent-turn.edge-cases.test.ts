// Edge-case audit (2026-11-04): cancellation races with tool execution and
// partial failures in parallel groups, through the real turn loop. Real
// (isolated) database; OpenRouter mocked; tools are in-process fixtures —
// no provider is ever called.
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/providers/openrouter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/providers/openrouter")>();
  return { ...actual, callOpenRouter: vi.fn() };
});
// Trigger.dev's run cancellation is best-effort in cancelRun; never reach the real API.
vi.mock("@trigger.dev/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@trigger.dev/sdk")>();
  return { ...actual, runs: { ...actual.runs, cancel: vi.fn().mockResolvedValue(undefined) } };
});

import { z } from "zod";
import { callOpenRouter, type ProviderToolCall } from "@/providers/openrouter";
import { prisma } from "@/lib/prisma";
import { makeTestUser, cleanupTestUsers } from "@/test-utils/db-fixtures";
import { createToolRegistry } from "@/tools/registry";
import type { ToolDefinition } from "@/tools/types";
import type { RunEvent } from "@/contracts/run-event";
import type { TurnRuntime } from "./run-agent-turn";
import { cancelRun } from "@/services/agent-run";
import { executeAgentTurn } from "./run-agent-turn";

const mockCallOpenRouter = vi.mocked(callOpenRouter);
const createdUserIds: string[] = [];
beforeEach(() => mockCallOpenRouter.mockReset());
afterAll(() => cleanupTestUsers(createdUserIds));

async function setUp(label: string) {
  const owner = await makeTestUser(label);
  createdUserIds.push(owner.id);
  const chat = await prisma.chat.create({ data: { userId: owner.id } });
  const run = await prisma.agentRun.create({
    data: { chatId: chat.id, userId: owner.id, idempotencyKey: randomUUID(), status: "QUEUED", triggerRunId: `run_test_${randomUUID()}` },
  });
  await prisma.message.create({
    data: { chatId: chat.id, userId: owner.id, agentRunId: run.id, role: "USER", status: "COMPLETE", content: [{ type: "text", text: "go" }] },
  });
  return { owner, chat, run };
}

const call = (name: string, args: Record<string, unknown> = {}): ProviderToolCall => ({
  id: randomUUID(),
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const toolRound = (calls: ProviderToolCall[]) => async () => ({ model: "x/y:free", text: null, toolCalls: calls, promptTokens: 1, completionTokens: 1 });
const answer = (text: string) => async () => ({ model: "x/y:free", text, toolCalls: null, promptTokens: 1, completionTokens: 1 });

const runtime: TurnRuntime = {
  openTextStream: () => ({ write: () => {}, close: async () => {} }),
  waitpoints: { createToken: () => Promise.reject(new Error("unused")), forToken: () => Promise.reject(new Error("unused")) },
};

function capture() {
  const events: RunEvent[] = [];
  return { events, publish: (e: RunEvent) => void events.push(e) };
}

/** A non-billable fixture tool: optional hook runs mid-execution; `fail` returns a tool error. */
function fixture(name: string, opts: { delayMs?: number; during?: () => Promise<void>; fail?: boolean } = {}): ToolDefinition<{ n: number }, { n: number }> {
  return {
    name,
    description: `fixture ${name}`,
    inputSchema: z.object({ n: z.number() }),
    outputSchema: z.object({ n: z.number() }),
    async execute(input) {
      await opts.during?.();
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.fail) throw new Error(`${name} failed`);
      return { n: input.n };
    },
  };
}

const assistant = (runId: string) => prisma.message.findFirstOrThrow({ where: { agentRunId: runId, role: "ASSISTANT" } });

describe("A. Stop while a tool is executing; the tool then succeeds (worker not yet stopped)", () => {
  it("the run stays CANCELLED: no COMPLETE message, no completion events, no further model round; the finished result is kept", async () => {
    const { owner, chat, run } = await setUp("edge-cancel-during-tool");
    const tool = fixture("slow_tool", { during: async () => void (await cancelRun(owner.id, chat.id, run.id)) });
    mockCallOpenRouter.mockImplementationOnce(toolRound([call("slow_tool", { n: 7 })])).mockImplementationOnce(answer("should never run"));
    const { events, publish } = capture();

    const result = await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([tool]), publish, undefined, runtime);

    expect(result.status).toBe("CANCELLED");
    expect(mockCallOpenRouter).toHaveBeenCalledTimes(1); // no model round after the cancellation
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("CANCELLED");
    const message = await assistant(run.id);
    expect(message.status).toBe("CANCELLED"); // a late success never overwrites the cancellation
    // The provider-side work finished and is kept (and, for billable tools, charged — existing policy).
    const blocks = message.content as Array<{ type: string; output?: { n: number } }>;
    expect(blocks.find((b) => b.type === "tool_result")?.output).toEqual({ n: 7 });
    expect(JSON.stringify(blocks)).not.toContain("should never run");
    // Nothing announces a completion for a cancelled run.
    expect(events.some((e) => e.type === "run_status" && e.status === "COMPLETED")).toBe(false);
    expect(events.some((e) => e.type === "assistant_message" && e.status === "COMPLETE")).toBe(false);
    const invocations = await prisma.toolInvocation.findMany({ where: { agentRunId: run.id } });
    expect(invocations.map((i) => i.status)).toEqual(["COMPLETED"]); // executed exactly once
  });

  it("a re-delivered execution of the cancelled run does nothing (no tool, no model call)", async () => {
    const { owner, chat, run } = await setUp("edge-cancel-redelivery");
    const tool = fixture("slow_tool", { during: async () => void (await cancelRun(owner.id, chat.id, run.id)) });
    mockCallOpenRouter.mockImplementationOnce(toolRound([call("slow_tool", { n: 1 })]));
    await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([tool]), capture().publish, undefined, runtime);
    mockCallOpenRouter.mockReset();

    const again = await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([tool]), capture().publish, undefined, runtime);
    expect(again).toMatchObject({ status: "CANCELLED", skipped: true });
    expect(mockCallOpenRouter).not.toHaveBeenCalled();
    expect(await prisma.toolInvocation.count({ where: { agentRunId: run.id } })).toBe(1);
  });
});

describe("E. Parallel execution: partial and total failure, cancellation mid-group", () => {
  it("one call fails while others succeed: every outcome is recorded in order, the model sees all of them, the run completes", async () => {
    const { run } = await setUp("edge-parallel-partial");
    const registry = createToolRegistry([fixture("ok_tool", { delayMs: 50 }), fixture("bad_tool", { fail: true })]);
    const calls = [call("ok_tool", { n: 1 }), call("bad_tool", { n: 2 }), call("ok_tool", { n: 3 })];
    let seen: Array<{ role: string; tool_call_id?: string; content?: string }> = [];
    mockCallOpenRouter.mockImplementationOnce(toolRound(calls)).mockImplementationOnce(async (messages) => {
      seen = messages as typeof seen;
      return { model: "x/y:free", text: "partial done", toolCalls: null, promptTokens: 1, completionTokens: 1 };
    });

    const result = await executeAgentTurn({ agentRunId: run.id }, registry, capture().publish, undefined, runtime);

    expect(result.status).toBe("COMPLETED");
    const invocations = await prisma.toolInvocation.findMany({ where: { agentRunId: run.id }, orderBy: { createdAt: "asc" } });
    expect(invocations.map((i) => i.status).sort()).toEqual(["COMPLETED", "COMPLETED", "FAILED"]);
    const results = ((await assistant(run.id)).content as Array<{ type: string; toolInvocationId?: string; error?: unknown }>).filter((b) => b.type === "tool_result");
    expect(results).toHaveLength(3);
    expect(results.map((b) => (b.error ? "error" : "ok"))).toEqual(["ok", "error", "ok"]); // call order kept
    expect(seen.filter((m) => m.role === "tool").map((m) => m.tool_call_id)).toEqual(calls.map((c) => c.id));
  });

  it("every call fails: all failures recorded, the run still reaches a terminal state (no stuck RUNNING)", async () => {
    const { run } = await setUp("edge-parallel-all-fail");
    const registry = createToolRegistry([fixture("bad_a", { fail: true }), fixture("bad_b", { fail: true })]);
    mockCallOpenRouter.mockImplementationOnce(toolRound([call("bad_a", { n: 1 }), call("bad_b", { n: 2 })])).mockImplementationOnce(answer("both failed"));

    const result = await executeAgentTurn({ agentRunId: run.id }, registry, capture().publish, undefined, runtime);

    expect(result.status).toBe("COMPLETED");
    const invocations = await prisma.toolInvocation.findMany({ where: { agentRunId: run.id } });
    expect(invocations.map((i) => i.status)).toEqual(["FAILED", "FAILED"]);
    expect(await prisma.toolInvocation.count({ where: { agentRunId: run.id, status: "RUNNING" } })).toBe(0);
  });

  it("Stop while several calls run: the group finishes once, results are kept, no further round, the run stays CANCELLED", async () => {
    const { owner, chat, run } = await setUp("edge-parallel-cancel");
    const registry = createToolRegistry([
      fixture("slow_tool", { delayMs: 300 }),
      fixture("stopper", { during: async () => void (await cancelRun(owner.id, chat.id, run.id)) }),
    ]);
    mockCallOpenRouter.mockImplementationOnce(toolRound([call("slow_tool", { n: 1 }), call("stopper", { n: 2 }), call("slow_tool", { n: 3 })]));

    const result = await executeAgentTurn({ agentRunId: run.id }, registry, capture().publish, undefined, runtime);

    expect(result.status).toBe("CANCELLED");
    expect(mockCallOpenRouter).toHaveBeenCalledTimes(1);
    const message = await assistant(run.id);
    expect(message.status).toBe("CANCELLED");
    const invocations = await prisma.toolInvocation.findMany({ where: { agentRunId: run.id } });
    expect(invocations).toHaveLength(3); // each call executed exactly once
    expect(invocations.every((i) => i.status === "COMPLETED")).toBe(true);
  });
});
