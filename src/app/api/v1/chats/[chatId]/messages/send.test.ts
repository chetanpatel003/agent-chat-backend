// This file tests HTTP wiring only (status codes, response shape,
// header handling) — it has no need for a genuine Trigger.dev dispatch,
// so the task's own `.trigger()` is mocked here. The one place a real
// dispatch is deliberately exercised end to end is checkpoint 2.1's
// send-turn.test.ts; letting *this* file also dispatch for real (as it
// did before the task had real OpenRouter logic) meant every test run
// burned real OpenRouter quota and left orphaned failed-retry runs in
// Trigger.dev's dashboard once this test's own cleanup deleted the rows
// before the async task's retries could finish — a real, avoidable cost,
// not a correctness issue, but not worth paying repeatedly either.
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@clerk/backend", () => ({ verifyToken: vi.fn() }));
vi.mock("@/lib/clerk", () => ({ clerkClient: { users: { getUser: vi.fn() } } }));
vi.mock("@/trigger/run-agent-turn", () => ({
  // A fresh id per call, not one fixed value for the whole file —
  // AgentRun.triggerRunId is unique, and more than one test here now
  // dispatches successfully (checkpoint 2.4's duplicate-Idempotency-Key
  // test is a second one), so a shared fixed id collides.
  runAgentTurn: { trigger: vi.fn(() => Promise.resolve({ id: `run_mocked_${randomUUID()}` })) },
}));

// Title generation is dispatched after every first message; never let a test reach Trigger.dev through it.
vi.mock("@/trigger/generate-chat-title", () => ({ dispatchChatTitle: vi.fn().mockResolvedValue(true) }));
import { verifyToken } from "@clerk/backend";
import { clerkClient } from "@/lib/clerk";
import { POST } from "./route";
import { GET as getActiveRunRoute } from "../runs/active/route";
import { prisma } from "@/lib/prisma";
import { cleanupTestUsers } from "@/test-utils/db-fixtures";

const mockVerifyToken = vi.mocked(verifyToken);
const mockGetUser = vi.mocked(clerkClient.users.getUser);
const CLERK_ID_PREFIX = "test_ckpt2.1_send_route_";

beforeEach(() => {
  mockVerifyToken.mockReset();
  mockGetUser.mockReset();
});

afterAll(async () => {
  const rows = await prisma.user.findMany({
    where: { clerkUserId: { startsWith: CLERK_ID_PREFIX } },
    select: { id: true },
  });
  await cleanupTestUsers(rows.map((r) => r.id));
});

async function authedRequestAs(clerkUserId: string, url: string, init: RequestInit = {}) {
  mockVerifyToken.mockResolvedValueOnce({ sub: clerkUserId } as never);
  mockGetUser.mockResolvedValueOnce({
    id: clerkUserId,
    emailAddresses: [{ id: "em1", emailAddress: `${clerkUserId}@example.com` }],
    primaryEmailAddressId: "em1",
    firstName: null,
    lastName: null,
    imageUrl: "",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double
  } as any);
  return new Request(url, {
    ...init,
    headers: { ...init.headers, Authorization: "Bearer good-token" },
  });
}

function routeCtx(chatId: string) {
  return { params: Promise.resolve({ chatId }) };
}

describe("POST /api/v1/chats/[chatId]/messages", () => {
  it("rejects a send with no Idempotency-Key header", async () => {
    const clerkUserId = `${CLERK_ID_PREFIX}${randomUUID()}`;
    const owner = await prisma.user.create({
      data: { clerkUserId, email: `${clerkUserId}@example.com` },
    });
    const chat = await prisma.chat.create({ data: { userId: owner.id } });

    const req = await authedRequestAs(clerkUserId, `http://localhost/x`, {
      method: "POST",
      body: JSON.stringify({ text: "hi" }),
    });
    const res = await POST(req, routeCtx(chat.id));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/idempotency-key/i);
  });

  it("rejects an invalid body (empty text) with no internal leak", async () => {
    const clerkUserId = `${CLERK_ID_PREFIX}${randomUUID()}`;
    const owner = await prisma.user.create({
      data: { clerkUserId, email: `${clerkUserId}@example.com` },
    });
    const chat = await prisma.chat.create({ data: { userId: owner.id } });

    const req = await authedRequestAs(clerkUserId, `http://localhost/x`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ text: "" }),
    });
    const res = await POST(req, routeCtx(chat.id));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toMatch(/at\s+\w+\s+\(.*:\d+:\d+\)/);
  });

  it(
    "accepts a valid send (202) and the dispatched run is then visible via GET .../runs/active",
    async () => {
      const clerkUserId = `${CLERK_ID_PREFIX}${randomUUID()}`;
      const owner = await prisma.user.create({
        data: { clerkUserId, email: `${clerkUserId}@example.com` },
      });
      const chat = await prisma.chat.create({ data: { userId: owner.id } });

      const sendReq = await authedRequestAs(clerkUserId, `http://localhost/x`, {
        method: "POST",
        headers: { "Idempotency-Key": randomUUID() },
        body: JSON.stringify({ text: "hello from the route test" }),
      });
      const sendRes = await POST(sendReq, routeCtx(chat.id));
      expect(sendRes.status).toBe(202);
      const sendBody = await sendRes.json();
      expect(sendBody.data.chatId).toBe(chat.id);

      const activeReq = await authedRequestAs(clerkUserId, `http://localhost/y`);
      const activeRes = await getActiveRunRoute(activeReq, routeCtx(chat.id));
      expect(activeRes.status).toBe(200);
      const activeBody = await activeRes.json();
      // The task is mocked (never actually dispatched), so the run stays
      // QUEUED — this is purely a wiring check, not a behavioral one.
      expect(activeBody.data?.id).toBe(sendBody.data.runId);
      expect(activeBody.data?.status).toBe("QUEUED");
    },
  );

  it(
    "the same Idempotency-Key sent twice through the real route returns the same dispatch, not a " +
      "second message or run — checkpoint 2.4's 'through the route, not just the DB layer' requirement",
    async () => {
      const clerkUserId = `${CLERK_ID_PREFIX}${randomUUID()}`;
      const owner = await prisma.user.create({
        data: { clerkUserId, email: `${clerkUserId}@example.com` },
      });
      const chat = await prisma.chat.create({ data: { userId: owner.id } });
      const key = randomUUID();

      const firstReq = await authedRequestAs(clerkUserId, `http://localhost/x`, {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body: JSON.stringify({ text: "once" }),
      });
      const firstRes = await POST(firstReq, routeCtx(chat.id));
      expect(firstRes.status).toBe(202);
      const firstBody = await firstRes.json();

      const secondReq = await authedRequestAs(clerkUserId, `http://localhost/x`, {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body: JSON.stringify({ text: "once (retried)" }),
      });
      const secondRes = await POST(secondReq, routeCtx(chat.id));
      expect(secondRes.status).toBe(202);
      const secondBody = await secondRes.json();

      expect(secondBody.data.runId).toBe(firstBody.data.runId);
      expect(secondBody.data.messageId).toBe(firstBody.data.messageId);

      const runCount = await prisma.agentRun.count({ where: { chatId: chat.id } });
      expect(runCount).toBe(1);
      const messageCount = await prisma.message.count({ where: { chatId: chat.id, role: "USER" } });
      expect(messageCount).toBe(1);
    },
  );
});
