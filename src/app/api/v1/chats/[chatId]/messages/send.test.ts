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
  runAgentTurn: { trigger: vi.fn().mockResolvedValue({ id: `run_mocked_${randomUUID()}` }) },
}));

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
});
