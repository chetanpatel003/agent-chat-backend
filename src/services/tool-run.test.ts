import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/providers/openrouter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/providers/openrouter")>();
  return { ...actual, callOpenRouter: vi.fn() };
});
vi.mock("@/trigger/run-agent-turn", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/trigger/run-agent-turn")>();
  return { ...actual, runAgentTurn: { trigger: vi.fn(async () => ({ id: `run_mocked_${randomUUID()}` })) } };
});

import { callOpenRouter } from "@/providers/openrouter";
import { runAgentTurn, executeAgentTurn, type TurnRuntime } from "@/trigger/run-agent-turn";
import { prisma } from "@/lib/prisma";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { makeTestUser, cleanupTestUsers } from "@/test-utils/db-fixtures";
import { createToolRegistry } from "@/tools/registry";
import { fixtureTool, FIXTURE_TOOL_NAME } from "@/test-utils/fixture-tool";
import { BILLABLE_TOOL_NAMES } from "@/services/credit-settlement";
import { DIRECT_TOOL_NAMES } from "@/contracts/tool-run";
import { submitToolRun } from "./tool-run";

const createdUserIds: string[] = [];
beforeEach(() => {
  vi.mocked(callOpenRouter).mockReset();
  vi.mocked(runAgentTurn.trigger).mockClear();
});
afterAll(() => cleanupTestUsers(createdUserIds));
// Title generation is dispatched after every first message; never let a test reach Trigger.dev through it.
vi.mock("@/trigger/generate-chat-title", () => ({ dispatchChatTitle: vi.fn().mockResolvedValue(true) }));
async function user(label: string) {
  const u = await makeTestUser(label);
  createdUserIds.push(u.id);
  return u;
}

const runtime: TurnRuntime = {
  openTextStream: () => ({ write: () => {}, close: async () => {} }),
  waitpoints: { createToken: () => Promise.reject(new Error("unused")), forToken: () => Promise.reject(new Error("unused")) },
  webhooks: async () => {},
};

describe("submitToolRun (admission)", () => {
  it("exposes exactly the billable Magica tools", () => {
    expect([...DIRECT_TOOL_NAMES].sort()).toEqual([...BILLABLE_TOOL_NAMES].sort());
  });

  it("rejects input that fails the tool's own schema before persisting anything", async () => {
    const owner = await user("toolrun-invalid");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    await expect(
      submitToolRun(owner.id, chat.id, randomUUID(), { tool: "merge_videos", input: { video_urls: ["https://cdn.example.com/a.mp4"] } }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await prisma.agentRun.count({ where: { chatId: chat.id } })).toBe(0);
    expect(runAgentTurn.trigger).not.toHaveBeenCalled();
  });

  it("admits a valid request as a run of the chat and dispatches the direct tool call", async () => {
    const owner = await user("toolrun-valid");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const input = { video_urls: ["https://cdn.example.com/a.mp4", "https://cdn.example.com/b.mp4"], transition: "fade" };
    const sent = await submitToolRun(owner.id, chat.id, randomUUID(), { tool: "merge_videos", input });
    expect(runAgentTurn.trigger).toHaveBeenCalledWith(
      { agentRunId: sent.runId, directTool: { name: "merge_videos", input } },
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    const message = await prisma.message.findUniqueOrThrow({ where: { id: sent.messageId } });
    expect(JSON.stringify(message.content)).toContain("merge_videos");
  });

  it("enforces chat ownership", async () => {
    const owner = await user("toolrun-owner");
    const intruder = await user("toolrun-intruder");
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    await expect(
      submitToolRun(intruder.id, chat.id, randomUUID(), { tool: "crop_image", input: { image_url: "https://cdn.example.com/a.png" } }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("direct tool execution (worker)", () => {
  async function queuedRun(label: string) {
    const owner = await user(label);
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const run = await prisma.agentRun.create({ data: { chatId: chat.id, userId: owner.id, idempotencyKey: randomUUID(), status: "QUEUED" } });
    await prisma.message.create({
      data: { chatId: chat.id, userId: owner.id, agentRunId: run.id, role: "USER", status: "COMPLETE", content: [{ type: "text", text: "Run tool" }] },
    });
    return run;
  }

  it("runs the one call through the normal tool path without calling the model, and completes", async () => {
    const run = await queuedRun("toolrun-exec-ok");
    const result = await executeAgentTurn(
      { agentRunId: run.id, directTool: { name: FIXTURE_TOOL_NAME, input: { timezone: "UTC" } } },
      createToolRegistry([fixtureTool]),
      () => {},
      undefined,
      runtime,
    );
    expect(result.status).toBe("COMPLETED");
    expect(callOpenRouter).not.toHaveBeenCalled();
    const invocation = await prisma.toolInvocation.findFirstOrThrow({ where: { agentRunId: run.id } });
    expect(invocation).toMatchObject({ toolName: FIXTURE_TOOL_NAME, status: "COMPLETED" });
    const message = await prisma.message.findFirstOrThrow({ where: { agentRunId: run.id, role: "ASSISTANT" } });
    expect((message.content as { type: string }[]).map((b) => b.type)).toEqual(["tool_use", "tool_result"]);
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).model).toBeNull();
  });

  it("a failing tool ends the run FAILED with the tool's error, keeping the blocks", async () => {
    const run = await queuedRun("toolrun-exec-fail");
    const result = await executeAgentTurn(
      { agentRunId: run.id, directTool: { name: FIXTURE_TOOL_NAME, input: { simulateFailure: true } } },
      createToolRegistry([fixtureTool]),
      () => {},
      undefined,
      runtime,
    );
    expect(result.status).toBe("FAILED");
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ errorCode: "EXECUTION_FAILED" });
    const message = await prisma.message.findFirstOrThrow({ where: { agentRunId: run.id, role: "ASSISTANT" } });
    expect(message.status).toBe("FAILED");
    expect((message.content as unknown[]).length).toBe(2);
    expect(callOpenRouter).not.toHaveBeenCalled();
  });
});
