import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/providers/openrouter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/providers/openrouter")>();
  return { ...actual, callOpenRouter: vi.fn() };
});

import { callOpenRouter, OpenRouterDefiniteError } from "@/providers/openrouter";
import { prisma } from "@/lib/prisma";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { makeTestUser, cleanupTestUsers } from "@/test-utils/db-fixtures";
import { createToolRegistry } from "@/tools/registry";
import { fixtureTool, FIXTURE_TOOL_NAME } from "@/test-utils/fixture-tool";
import { executeAgentTurn, type TurnRuntime } from "@/trigger/run-agent-turn";
import type { WebhookEvent } from "@/contracts/webhook";
import {
  createWebhookEndpoint,
  createWebhookNotifier,
  deliverWebhook,
  disableWebhookEndpoint,
  listWebhookEndpoints,
  signWebhook,
  verifyWebhookSignature,
  type WebhookDispatcher,
} from "./webhooks";

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

const event = (overrides: Partial<WebhookEvent> = {}): WebhookEvent => ({
  id: `evt_agent.completed_${randomUUID()}`,
  type: "agent.completed",
  createdAt: new Date().toISOString(),
  data: { runId: randomUUID(), chatId: randomUUID(), status: "COMPLETED" },
  ...overrides,
});

describe("webhook endpoints", () => {
  it("creates an endpoint (secret shown once), lists it without the secret, and disables it idempotently", async () => {
    const owner = await user("wh-crud");
    const created = await createWebhookEndpoint(owner.id, { url: "https://hooks.example.com/agent", events: ["agent.completed"] });
    expect(created.secret).toMatch(/^whsec_/);
    const listed = await listWebhookEndpoints(owner.id);
    expect(listed.items).toEqual([{ id: created.id, url: created.url, events: ["agent.completed"], createdAt: created.createdAt, disabledAt: null }]);
    expect(JSON.stringify(listed)).not.toContain(created.secret);
    const disabled = await disableWebhookEndpoint(owner.id, created.id);
    expect(disabled.disabledAt).not.toBeNull();
    expect((await disableWebhookEndpoint(owner.id, created.id)).disabledAt).toBe(disabled.disabledAt);
  });

  it("another user's endpoint is not found", async () => {
    const owner = await user("wh-owner");
    const intruder = await user("wh-intruder");
    const created = await createWebhookEndpoint(owner.id, { url: "https://hooks.example.com/a", events: ["agent.started"] });
    await expect(disableWebhookEndpoint(intruder.id, created.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listWebhookEndpoints(intruder.id)).items).toEqual([]);
  });

  it.each(["http://hooks.example.com/x", "https://localhost/x", "https://127.0.0.1/x", "https://10.0.0.5/x", "https://192.168.1.2/x", "https://[::1]/x", "https://metadata.internal/x"])(
    "refuses a non-public or non-https URL: %s",
    async (url) => {
      const owner = await user("wh-ssrf");
      await expect(createWebhookEndpoint(owner.id, { url, events: ["agent.started"] })).rejects.toBeInstanceOf(ValidationError);
    },
  );
});

describe("signatures", () => {
  it("verifies its own signature, rejects tampering, a wrong secret and stale timestamps", () => {
    const body = JSON.stringify(event());
    const now = Date.now();
    const ts = Math.floor(now / 1000);
    const signature = signWebhook("whsec_a", "evt_1", ts, body);
    const headers = { id: "evt_1", timestamp: String(ts), signature };
    expect(verifyWebhookSignature("whsec_a", headers, body, now)).toBe(true);
    expect(verifyWebhookSignature("whsec_a", headers, body + " ", now)).toBe(false);
    expect(verifyWebhookSignature("whsec_b", headers, body, now)).toBe(false);
    expect(verifyWebhookSignature("whsec_a", headers, body, now + 10 * 60_000)).toBe(false);
  });
});

describe("deliverWebhook", () => {
  async function endpoint(label: string) {
    const owner = await user(label);
    return createWebhookEndpoint(owner.id, { url: "https://hooks.example.com/in", events: ["agent.completed"] });
  }

  it("POSTs the event with verifiable Standard-Webhooks headers; 2xx is delivered", async () => {
    const ep = await endpoint("wh-deliver-ok");
    const e = event();
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      const ok = verifyWebhookSignature(
        ep.secret,
        { id: headers["webhook-id"], timestamp: headers["webhook-timestamp"], signature: headers["webhook-signature"] },
        String(init?.body),
      );
      return new Response(null, { status: ok ? 204 : 401 });
    });
    expect(await deliverWebhook(ep.id, e, fetchImpl as typeof fetch)).toBe("delivered");
    expect(fetchImpl).toHaveBeenCalledWith(ep.url, expect.objectContaining({ method: "POST", redirect: "manual" }));
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual(e);
  });

  it.each([500, 503, 429, 408])("HTTP %s throws so the durable task retries", async (status) => {
    const ep = await endpoint(`wh-retry-${status}`);
    await expect(deliverWebhook(ep.id, event(), (async () => new Response(null, { status })) as typeof fetch)).rejects.toThrow(/will retry/);
  });

  it("a network error throws (retried)", async () => {
    const ep = await endpoint("wh-network");
    await expect(deliverWebhook(ep.id, event(), (async () => Promise.reject(new TypeError("fetch failed"))) as typeof fetch)).rejects.toThrow();
  });

  it.each([400, 401, 404, 410])("HTTP %s is a permanent failure, not retried", async (status) => {
    const ep = await endpoint(`wh-permanent-${status}`);
    expect(await deliverWebhook(ep.id, event(), (async () => new Response(null, { status })) as typeof fetch)).toBe("permanent_failure");
  });

  it("a disabled endpoint is skipped without a request", async () => {
    const ep = await endpoint("wh-disabled");
    const owner = (await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } })).userId;
    await disableWebhookEndpoint(owner, ep.id);
    const fetchImpl = vi.fn();
    expect(await deliverWebhook(ep.id, event(), fetchImpl as unknown as typeof fetch)).toBe("skipped_disabled");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("lifecycle events from the agent turn", () => {
  const runtime = (dispatch: WebhookDispatcher): TurnRuntime => ({
    openTextStream: () => ({ write: () => {}, close: async () => {} }),
    waitpoints: { createToken: () => Promise.reject(new Error("unused")), forToken: () => Promise.reject(new Error("unused")) },
    webhooks: dispatch,
  });

  async function setUp(label: string, events: WebhookEvent["type"][]) {
    const owner = await user(label);
    const chat = await prisma.chat.create({ data: { userId: owner.id } });
    const run = await prisma.agentRun.create({ data: { chatId: chat.id, userId: owner.id, idempotencyKey: randomUUID(), status: "QUEUED" } });
    await prisma.message.create({
      data: { chatId: chat.id, userId: owner.id, agentRunId: run.id, role: "USER", status: "COMPLETE", content: [{ type: "text", text: "hi" }] },
    });
    const ep = await createWebhookEndpoint(owner.id, { url: "https://hooks.example.com/x", events });
    return { owner, chat, run, ep };
  }

  it("emits agent.started, tool.completed and agent.completed with stable ids and no content", async () => {
    const { run, ep } = await setUp("wh-turn-success", ["agent.started", "agent.completed", "tool.completed", "agent.failed"]);
    const sent: { endpointId: string; event: WebhookEvent }[] = [];
    mockCallOpenRouter
      .mockResolvedValueOnce({
        model: "x/y:free",
        text: null,
        toolCalls: [{ id: randomUUID(), type: "function", function: { name: FIXTURE_TOOL_NAME, arguments: "{}" } }],
        promptTokens: 1,
        completionTokens: 1,
      })
      .mockResolvedValueOnce({ model: "x/y:free", text: "secret answer text", toolCalls: null, promptTokens: 1, completionTokens: 1 });

    const result = await executeAgentTurn(
      { agentRunId: run.id },
      createToolRegistry([fixtureTool]),
      () => {},
      undefined,
      runtime(async (endpointId, e) => void sent.push({ endpointId, event: e })),
    );
    expect(result.status).toBe("COMPLETED");
    expect(sent.map((s) => s.event.type)).toEqual(["agent.started", "tool.completed", "agent.completed"]);
    expect(sent.every((s) => s.endpointId === ep.id)).toBe(true);
    expect(sent[0].event.id).toBe(`evt_agent.started_${run.id}`);
    expect(sent[1].event.data).toMatchObject({ toolName: FIXTURE_TOOL_NAME, toolInvocationId: expect.any(String) });
    expect(JSON.stringify(sent)).not.toContain("secret answer text");
  });

  it("emits agent.failed with the error code, only to subscribed endpoints", async () => {
    const { run } = await setUp("wh-turn-failure", ["agent.failed"]);
    const sent: WebhookEvent[] = [];
    mockCallOpenRouter.mockRejectedValueOnce(new OpenRouterDefiniteError("rate limited", "RATE_LIMITED"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([]), () => {}, undefined, runtime(async (_id, e) => void sent.push(e)));
    expect(sent.map((e) => [e.type, e.data.status, e.data.errorCode])).toEqual([["agent.failed", "FAILED", "RATE_LIMITED"]]);
  });

  it("a user without endpoints costs nothing and never dispatches", async () => {
    const owner = await user("wh-none");
    const dispatch = vi.fn();
    expect(await createWebhookNotifier(dispatch, { id: randomUUID(), chatId: randomUUID(), userId: owner.id })).toBeNull();
  });

  it("a skipped (already terminal) execution emits nothing", async () => {
    const { run } = await setUp("wh-turn-skipped", ["agent.started", "agent.completed", "agent.failed"]);
    await prisma.agentRun.update({ where: { id: run.id }, data: { status: "COMPLETED", completedAt: new Date() } });
    const dispatch = vi.fn();
    await executeAgentTurn({ agentRunId: run.id }, createToolRegistry([]), () => {}, undefined, runtime(dispatch));
    expect(dispatch).not.toHaveBeenCalled();
  });
});
