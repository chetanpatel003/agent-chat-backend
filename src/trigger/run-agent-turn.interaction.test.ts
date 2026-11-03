import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/providers/openrouter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/providers/openrouter")>();
  return { ...actual, callOpenRouter: vi.fn() };
});

import { z } from "zod";
import {
  callOpenRouter,
  OpenRouterDefiniteError,
  type CallOpenRouterOptions,
  type ProviderToolCall,
} from "@/providers/openrouter";
import { prisma } from "@/lib/prisma";
import { makeTestUser, cleanupTestUsers } from "@/test-utils/db-fixtures";
import { createToolRegistry } from "@/tools/registry";
import type { ToolDefinition } from "@/tools/types";
import type { PublishRunEvent } from "@/realtime/publish-run-event";
import type { RunEvent } from "@/contracts/run-event";
import type { TextStreamPart } from "@/contracts/text-stream";
import type { TextStreamSink } from "@/realtime/text-stream";
import { cancelRun } from "@/services/agent-run";
import { resolveWaitpoint, type WaitpointRuntime, type WaitpointTokenClient } from "@/services/waitpoint";
import { executeAgentTurn, type TurnRuntime } from "./run-agent-turn";

// Core interaction experience (streaming, thinking/steps, plan-mode
// waitpoints, stop, parallel tools) against the real database, with the
// provider mocked and the Trigger.dev-only capabilities injected.

const mockCallOpenRouter = vi.mocked(callOpenRouter);
const createdUserIds: string[] = [];

beforeEach(() => {
  mockCallOpenRouter.mockReset();
});
afterAll(() => cleanupTestUsers(createdUserIds));

async function user(label: string) {
  const u = await makeTestUser(label);
  createdUserIds.push(u.id);
  return u;
}

async function setUpRun(owner: { id: string }, opts: { planMode?: boolean } = {}) {
  const chat = await prisma.chat.create({ data: { userId: owner.id } });
  const run = await prisma.agentRun.create({
    data: {
      chatId: chat.id,
      userId: owner.id,
      idempotencyKey: randomUUID(),
      status: "QUEUED",
      planMode: opts.planMode ?? false,
      triggerRunId: `run_test_${randomUUID()}`,
    },
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

/** A provider response that streams `chunks` through onTextDelta first. */
function streamed(chunks: string[], toolCalls: ProviderToolCall[] | null = null) {
  return async (_messages: unknown, _tools: unknown, options?: CallOpenRouterOptions) => {
    for (const chunk of chunks) await options?.onTextDelta?.(chunk);
    return {
      model: "x/y:free",
      text: chunks.join("").trim() || null,
      toolCalls,
      promptTokens: 1,
      completionTokens: 1,
    };
  };
}

function toolCall(name: string, args: Record<string, unknown> = {}): ProviderToolCall {
  return { id: randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function captureStream() {
  const parts: TextStreamPart[] = [];
  let closed = 0;
  const sink: TextStreamSink = {
    write: (part) => void parts.push(part),
    close: async () => void closed++,
  };
  return { parts, sink, closedCount: () => closed };
}

function capturePublish() {
  const events: RunEvent[] = [];
  const publish: PublishRunEvent = (event) => void events.push(event);
  return { events, publish };
}

/** In-memory stand-in for Trigger.dev waitpoint tokens: forToken resolves
 * when the token is completed (or "times out" on demand). */
function fakeTokens() {
  const tokens = new Map<string, { status: "WAITING" | "COMPLETED" | "TIMED_OUT"; resolve?: (ok: boolean) => void }>();
  const created: string[] = [];
  const runtime: WaitpointRuntime = {
    async createToken({ idempotencyKey }) {
      const id = `tok_${idempotencyKey}`;
      if (!tokens.has(id)) {
        tokens.set(id, { status: "WAITING" });
        created.push(id);
      }
      return { id };
    },
    forToken(tokenId) {
      const token = tokens.get(tokenId)!;
      if (token.status !== "WAITING") return Promise.resolve({ ok: token.status === "COMPLETED" });
      return new Promise((resolve) => {
        token.resolve = (ok) => resolve({ ok });
      });
    },
  };
  const completions: string[] = [];
  let failNextComplete = false;
  const client: WaitpointTokenClient = {
    async status(tokenId) {
      return tokens.get(tokenId)!.status;
    },
    async complete(tokenId) {
      if (failNextComplete) {
        failNextComplete = false;
        throw new Error("Trigger.dev unavailable");
      }
      const token = tokens.get(tokenId)!;
      if (token.status !== "WAITING") throw new Error("already completed");
      token.status = "COMPLETED";
      completions.push(tokenId);
      token.resolve?.(true);
    },
  };
  return {
    runtime,
    client,
    created,
    completions,
    failNextCompletion: () => (failNextComplete = true),
    timeOut: (tokenId: string) => {
      const token = tokens.get(tokenId)!;
      token.status = "TIMED_OUT";
      token.resolve?.(false);
    },
  };
}

/** Trigger.dev still running the turn (dev mode reports a waiting run as EXECUTING). */
const liveExecution = async () => "EXECUTING";

function runtimeWith(sink: TextStreamSink, waitpoints?: WaitpointRuntime): TurnRuntime {
  return {
    openTextStream: () => sink,
    waitpoints: waitpoints ?? {
      createToken: () => Promise.reject(new Error("no waitpoints in this test")),
      forToken: () => Promise.reject(new Error("no waitpoints in this test")),
    },
  };
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 20_000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function assistantMessage(runId: string) {
  return prisma.message.findFirstOrThrow({ where: { agentRunId: runId, role: "ASSISTANT" } });
}

describe("token streaming, thinking duration and steps", () => {
  it("streams visible text deltas, records thinking time, emits step events, and persists the final text", async () => {
    const owner = await user("stream-success");
    const { run } = await setUpRun(owner);
    mockCallOpenRouter.mockImplementationOnce(streamed(["Hel", "lo ", "there"]));
    const stream = captureStream();
    const { events, publish } = capturePublish();

    const result = await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([]), publish, undefined, runtimeWith(stream.sink));
    expect(result.status).toBe("COMPLETED");

    const message = await assistantMessage(run.id);
    expect(stream.parts.map((p) => p.delta)).toEqual(["Hel", "lo ", "there"]);
    expect(stream.parts.every((p) => p.messageId === message.id && p.round === 0)).toBe(true);
    expect(stream.closedCount()).toBe(1);

    expect(message.content).toEqual([{ type: "text", text: "Hello there" }]);
    expect(message.thinkingMs).toEqual(expect.any(Number));

    const types = events.map((e) => e.type);
    expect(types.indexOf("step")).toBeLessThan(types.indexOf("thinking_completed"));
    const steps = events.filter((e): e is Extract<RunEvent, { type: "step" }> => e.type === "step").map((e) => e.step);
    expect(steps).toEqual(["thinking", "responding"]);
    // Events never carry the text itself.
    expect(JSON.stringify(events)).not.toContain("there");
  });

  it("a mid-stream provider failure keeps the streamed partial text in the FAILED message", async () => {
    const owner = await user("stream-partial-failure");
    const { run } = await setUpRun(owner);
    mockCallOpenRouter.mockImplementationOnce(async (_m, _t, options) => {
      await options?.onTextDelta?.("Half an ");
      await options?.onTextDelta?.("answer");
      throw new OpenRouterDefiniteError("The OpenRouter stream was interrupted", "STREAM_INTERRUPTED", "Half an answer");
    });

    const result = await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([]), capturePublish().publish, undefined, runtimeWith(captureStream().sink));
    expect(result.status).toBe("FAILED");
    const message = await assistantMessage(run.id);
    expect(message.status).toBe("FAILED");
    expect(message.content).toEqual([{ type: "text", text: "Half an answer" }]);
    const updated = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(updated.errorCode).toBe("STREAM_INTERRUPTED");
  });

  it("Stop while text is streaming ends CANCELLED, keeps the partial text, and stops consuming the stream", async () => {
    const owner = await user("stream-stop");
    const { chat, run } = await setUpRun(owner);
    let deltasAfterCancel = 0;
    let cancelled = false;
    mockCallOpenRouter.mockImplementationOnce(async (_m, _t, options) => {
      await options?.onTextDelta?.("Partial ");
      await options?.onTextDelta?.("text");
      await cancelRun(owner.id, chat.id, run.id);
      cancelled = true;
      // Past the flush interval, so the next delta's flush detects the cancel.
      await new Promise((r) => setTimeout(r, 1100));
      for (const d of [" more", " and more"]) {
        await options?.onTextDelta?.(d);
        deltasAfterCancel++;
      }
      return { model: "x/y:free", text: "unused", toolCalls: null, promptTokens: 1, completionTokens: 1 };
    });

    const result = await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([]), capturePublish().publish, undefined, runtimeWith(captureStream().sink));
    expect(cancelled).toBe(true);
    expect(result).toMatchObject({ status: "CANCELLED", skipped: true });
    expect(deltasAfterCancel).toBe(0); // the flush threw: the stream was abandoned at once

    const message = await assistantMessage(run.id);
    expect(message.status).toBe("CANCELLED");
    expect(message.content).toEqual([{ type: "text", text: "Partial text more" }]);
  });
});

describe("parallel tool execution", () => {
  function delayedTool(name: string, delayMs: number, log: string[]): ToolDefinition<{ n: number }, { name: string; n: number }> {
    return {
      name,
      description: `Fixture tool ${name}`,
      inputSchema: z.object({ n: z.number() }),
      outputSchema: z.object({ name: z.string(), n: z.number() }),
      async execute(input) {
        log.push(`start:${name}:${input.n}`);
        await new Promise((r) => setTimeout(r, delayMs));
        log.push(`end:${name}:${input.n}`);
        return { name, n: input.n };
      },
    };
  }

  it("independent non-billable calls run concurrently; results, blocks and tool messages keep the model's order", async () => {
    const owner = await user("parallel-order");
    const { run } = await setUpRun(owner);
    const log: string[] = [];
    const registry = createToolRegistry([delayedTool("slow_tool", 1500, log), delayedTool("fast_tool", 50, log)]);
    // Warm the pool: opening a new Neon connection takes seconds from here,
    // which would otherwise be measured instead of the loop's concurrency.
    await Promise.all(Array.from({ length: 4 }, () => prisma.$queryRaw`SELECT 1`));
    const calls = [toolCall("slow_tool", { n: 1 }), toolCall("fast_tool", { n: 2 }), toolCall("fast_tool", { n: 3 })];
    let secondRoundMessages: unknown[] = [];
    mockCallOpenRouter.mockImplementationOnce(streamed([], calls)).mockImplementationOnce(async (messages) => {
      secondRoundMessages = messages;
      return { model: "x/y:free", text: "done", toolCalls: null, promptTokens: 1, completionTokens: 1 };
    });

    const result = await executeAgentTurn({ agentRunId: run.id }, registry, capturePublish().publish, undefined, runtimeWith(captureStream().sink));
    expect(result.status).toBe("COMPLETED");

    // Concurrency: the fast calls started and finished while the slow one ran.
    expect(log.indexOf("end:fast_tool:2")).toBeLessThan(log.indexOf("end:slow_tool:1"));
    expect(log.indexOf("end:fast_tool:3")).toBeLessThan(log.indexOf("end:slow_tool:1"));

    // Determinism: content and tool messages follow call order, not completion order.
    const message = await assistantMessage(run.id);
    const results = (message.content as Array<{ type: string; output?: { n: number } }>)
      .filter((b) => b.type === "tool_result")
      .map((b) => b.output?.n);
    expect(results).toEqual([1, 2, 3]);
    const toolMessages = (secondRoundMessages as Array<{ role: string; tool_call_id?: string }>).filter((m) => m.role === "tool");
    expect(toolMessages.map((m) => m.tool_call_id)).toEqual(calls.map((c) => c.id));

    const invocations = await prisma.toolInvocation.findMany({ where: { agentRunId: run.id } });
    expect(invocations).toHaveLength(3);
    expect(invocations.every((i) => i.status === "COMPLETED")).toBe(true);
  });

  it("billable and provider-backed tools never run concurrently, even when requested together", async () => {
    const owner = await user("parallel-billable-sequential");
    const { run } = await setUpRun(owner);
    const log: string[] = [];
    // Named like a billable Magica tool: forced sequential by name.
    const billable = delayedTool("crop_image", 200, log);
    // Has reconcile (provider-backed): forced sequential even though unlisted.
    const providerBacked: ToolDefinition<{ n: number }, { name: string; n: number }> = {
      ...delayedTool("provider_tool", 200, log),
      reconcile: async () => ({ status: "completed" as const, output: { name: "provider_tool", n: 0 } }),
    };
    const registry = createToolRegistry([billable, providerBacked]);
    mockCallOpenRouter
      .mockImplementationOnce(
        streamed([], [toolCall("crop_image", { n: 1 }), toolCall("crop_image", { n: 2 }), toolCall("provider_tool", { n: 3 })]),
      )
      .mockImplementationOnce(streamed(["done"]));

    const result = await executeAgentTurn({ agentRunId: run.id }, registry, capturePublish().publish, undefined, runtimeWith(captureStream().sink));
    expect(result.status).toBe("COMPLETED");
    expect(log).toEqual([
      "start:crop_image:1",
      "end:crop_image:1",
      "start:crop_image:2",
      "end:crop_image:2",
      "start:provider_tool:3",
      "end:provider_tool:3",
    ]);
  });
});

describe("plan mode (PLAN waitpoint)", () => {
  async function startPlanRun(label: string) {
    const owner = await user(label);
    const { chat, run } = await setUpRun(owner, { planMode: true });
    const tokens = fakeTokens();
    const { events, publish } = capturePublish();
    return { owner, chat, run, tokens, events, publish };
  }

  async function waitForPendingWaitpoint(runId: string) {
    await waitFor(async () => {
      const [wp, current] = await Promise.all([
        prisma.waitpoint.findFirst({ where: { agentRunId: runId, status: "PENDING" } }),
        prisma.agentRun.findUniqueOrThrow({ where: { id: runId } }),
      ]);
      return !!wp && current.status === "WAITING";
    });
    return prisma.waitpoint.findFirstOrThrow({ where: { agentRunId: runId } });
  }

  it("proposes a plan without tools, waits, and on approval resumes exactly once to finish the task", async () => {
    const { owner, chat, run, tokens, events, publish } = await startPlanRun("plan-approve");
    const seenTools: unknown[] = [];
    mockCallOpenRouter
      .mockImplementationOnce(async (messages, tools, options) => {
        seenTools.push(tools);
        return streamed(["1. Do the thing"])(messages, tools, options);
      })
      .mockImplementationOnce(async (messages, tools, options) => {
        seenTools.push(tools);
        return streamed(["Done as planned."])(messages, tools, options);
      });

    const execution = executeAgentTurn({ agentRunId: run.id }, createToolRegistry([]), publish, undefined, runtimeWith(captureStream().sink, tokens.runtime));
    const wp = await waitForPendingWaitpoint(run.id);
    expect(wp.type).toBe("PLAN");
    expect(wp.payload).toEqual({ plan: "1. Do the thing" });
    expect(wp.expiresAt!.getTime() - wp.createdAt.getTime()).toBeGreaterThan(23 * 3600_000);
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).waitingReason).toBe("PLAN");
    expect(seenTools[0]).toEqual([]); // no tools offered while planning

    // Duplicate submissions: one transition, one token completion, same answer.
    const [a, b] = await Promise.all([
      resolveWaitpoint(owner.id, chat.id, run.id, wp.id, { decision: "approve" }, tokens.client, liveExecution),
      resolveWaitpoint(owner.id, chat.id, run.id, wp.id, { decision: "reject" }, tokens.client, liveExecution),
    ]);
    expect(a.resolution).toEqual(b.resolution);

    const result = await execution;
    if (a.resolution?.decision === "approve") {
      expect(result.status).toBe("COMPLETED");
      const message = await assistantMessage(run.id);
      expect(message.content).toEqual([
        { type: "text", text: "1. Do the thing" },
        { type: "text", text: "Done as planned." },
      ]);
      expect(mockCallOpenRouter).toHaveBeenCalledTimes(2);
    } else {
      expect(result.status).toBe("COMPLETED");
      expect(mockCallOpenRouter).toHaveBeenCalledTimes(1);
    }
    expect(tokens.completions).toHaveLength(1);
    expect(tokens.created).toHaveLength(1);
    const statuses = events.filter((e): e is Extract<RunEvent, { type: "waitpoint" }> => e.type === "waitpoint").map((e) => e.status);
    expect(statuses).toEqual(["PENDING", "RESOLVED"]);
    const finalRun = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(finalRun.waitingReason).toBeNull();
  });

  it("reject completes the turn with the plan as the answer and never runs the task", async () => {
    const { owner, chat, run, tokens, publish } = await startPlanRun("plan-reject");
    mockCallOpenRouter.mockImplementationOnce(streamed(["1. Plan"]));
    const execution = executeAgentTurn({ agentRunId: run.id }, createToolRegistry([]), publish, undefined, runtimeWith(captureStream().sink, tokens.runtime));
    const wp = await waitForPendingWaitpoint(run.id);
    await resolveWaitpoint(owner.id, chat.id, run.id, wp.id, { decision: "reject" }, tokens.client, liveExecution);
    const result = await execution;
    expect(result.status).toBe("COMPLETED");
    expect(mockCallOpenRouter).toHaveBeenCalledTimes(1);
    expect((await assistantMessage(run.id)).content).toEqual([{ type: "text", text: "1. Plan" }]);
  });

  it("recovers when the decision committed but token completion failed: a repeat completes the same token once", async () => {
    const { owner, chat, run, tokens, publish } = await startPlanRun("plan-completion-retry");
    mockCallOpenRouter.mockImplementationOnce(streamed(["1. Plan"])).mockImplementationOnce(streamed(["Done."]));
    const execution = executeAgentTurn({ agentRunId: run.id }, createToolRegistry([]), publish, undefined, runtimeWith(captureStream().sink, tokens.runtime));
    const wp = await waitForPendingWaitpoint(run.id);

    tokens.failNextCompletion();
    await expect(resolveWaitpoint(owner.id, chat.id, run.id, wp.id, { decision: "approve" }, tokens.client, liveExecution)).rejects.toMatchObject({
      name: "WaitpointResumeError",
    });
    const saved = await prisma.waitpoint.findUniqueOrThrow({ where: { id: wp.id } });
    expect(saved.status).toBe("RESOLVED"); // decision durable despite the failure
    expect(tokens.completions).toHaveLength(0);

    const repeat = await resolveWaitpoint(owner.id, chat.id, run.id, wp.id, { decision: "approve" }, tokens.client, liveExecution);
    expect(repeat.status).toBe("RESOLVED");
    expect(await execution).toMatchObject({ status: "COMPLETED" });
    expect(tokens.completions).toEqual([wp.token]); // the same token, exactly once
    expect(tokens.created).toHaveLength(1); // no second waitpoint

    // A further duplicate after resumption changes nothing.
    await resolveWaitpoint(owner.id, chat.id, run.id, wp.id, { decision: "approve" }, tokens.client, liveExecution);
    expect(tokens.completions).toHaveLength(1);
  });

  it("an unanswered waitpoint expires: run and message CANCELLED with a how-to-continue reason, plan text kept", async () => {
    const { owner, chat, run, tokens, events, publish } = await startPlanRun("plan-expire");
    mockCallOpenRouter.mockImplementationOnce(streamed(["1. Plan"]));
    const execution = executeAgentTurn({ agentRunId: run.id }, createToolRegistry([]), publish, undefined, runtimeWith(captureStream().sink, tokens.runtime));
    const wp = await waitForPendingWaitpoint(run.id);
    tokens.timeOut(wp.token);

    const result = await execution;
    expect(result.status).toBe("CANCELLED");
    const [finalWp, finalRun, message] = await Promise.all([
      prisma.waitpoint.findUniqueOrThrow({ where: { id: wp.id } }),
      prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } }),
      assistantMessage(run.id),
    ]);
    expect(finalWp.status).toBe("EXPIRED");
    expect(finalRun.errorCode).toBe("WAITPOINT_EXPIRED");
    expect(finalRun.errorMessage).toMatch(/Send a new message to continue/);
    expect(message.status).toBe("CANCELLED");
    expect(message.content).toEqual([{ type: "text", text: "1. Plan" }]);
    expect(events.some((e) => e.type === "waitpoint" && e.status === "EXPIRED")).toBe(true);

    // A late decision is refused, never resumes anything.
    await expect(resolveWaitpoint(owner.id, chat.id, run.id, wp.id, { decision: "approve" }, tokens.client, liveExecution)).rejects.toMatchObject({
      name: "ConflictError",
    });
    expect(tokens.completions).toHaveLength(0);
  });

  it("Stop while waiting cancels the waitpoint; a later decision is refused", async () => {
    const { owner, chat, run, tokens, publish } = await startPlanRun("plan-stop-waiting");
    mockCallOpenRouter.mockImplementationOnce(streamed(["1. Plan"]));
    const execution = executeAgentTurn({ agentRunId: run.id }, createToolRegistry([]), publish, undefined, runtimeWith(captureStream().sink, tokens.runtime));
    const wp = await waitForPendingWaitpoint(run.id);

    const stopped = await cancelRun(owner.id, chat.id, run.id);
    expect(stopped.status).toBe("CANCELLED");
    expect((await prisma.waitpoint.findUniqueOrThrow({ where: { id: wp.id } })).status).toBe("CANCELLED");
    await expect(resolveWaitpoint(owner.id, chat.id, run.id, wp.id, { decision: "approve" }, tokens.client, liveExecution)).rejects.toMatchObject({
      name: "ConflictError",
    });

    // In production runs.cancel ends the suspended task; here release it to finish the test.
    tokens.timeOut(wp.token);
    expect(await execution).toMatchObject({ status: "CANCELLED" });
    expect((await assistantMessage(run.id)).content).toEqual([{ type: "text", text: "1. Plan" }]);
  });

  it("rejects an invalid decision and another user's resolve attempt without leaking existence", async () => {
    const { owner, chat, run, tokens, publish } = await startPlanRun("plan-validation");
    const stranger = await user("plan-stranger");
    mockCallOpenRouter.mockImplementationOnce(streamed(["1. Plan"]));
    const execution = executeAgentTurn({ agentRunId: run.id }, createToolRegistry([]), publish, undefined, runtimeWith(captureStream().sink, tokens.runtime));
    const wp = await waitForPendingWaitpoint(run.id);

    await expect(resolveWaitpoint(owner.id, chat.id, run.id, wp.id, { decision: "maybe" }, tokens.client, liveExecution)).rejects.toMatchObject({
      name: "ValidationError",
    });
    await expect(resolveWaitpoint(stranger.id, chat.id, run.id, wp.id, { decision: "approve" }, tokens.client, liveExecution)).rejects.toMatchObject({
      name: "NotFoundError",
    });
    expect((await prisma.waitpoint.findUniqueOrThrow({ where: { id: wp.id } })).status).toBe("PENDING");

    await resolveWaitpoint(owner.id, chat.id, run.id, wp.id, { decision: "reject" }, tokens.client, liveExecution);
    await execution;
  });
});
