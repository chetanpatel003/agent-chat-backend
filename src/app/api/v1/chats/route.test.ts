import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@clerk/backend", () => ({ verifyToken: vi.fn() }));
vi.mock("@/lib/clerk", () => ({ clerkClient: { users: { getUser: vi.fn() } } }));

import { verifyToken } from "@clerk/backend";
import { clerkClient } from "@/lib/clerk";
import { GET, POST } from "./route";
import { prisma } from "@/lib/prisma";
import { cleanupTestUsers } from "@/test-utils/db-fixtures";

const mockVerifyToken = vi.mocked(verifyToken);
const mockGetUser = vi.mocked(clerkClient.users.getUser);
const CLERK_ID_PREFIX = "test_ckpt1.3_chats_route_";

beforeEach(() => {
  mockVerifyToken.mockReset();
  mockGetUser.mockReset();
});

afterAll(async () => {
  // Each authedRequest() call creates a real local user via the actual
  // authenticate() flow — simplest correct cleanup is to sweep by the
  // prefix every one of them shares, rather than track ids by hand
  // through many ad-hoc calls.
  const rows = await prisma.user.findMany({
    where: { clerkUserId: { startsWith: CLERK_ID_PREFIX } },
    select: { id: true },
  });
  await cleanupTestUsers(rows.map((r) => r.id));
});

async function authedRequest(url: string, init: RequestInit = {}) {
  const clerkUserId = `${CLERK_ID_PREFIX}${randomUUID()}`;
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

describe("GET /api/v1/chats", () => {
  it("returns 401 with no leaked internals when unauthenticated", async () => {
    const res = await GET(new Request("http://localhost/api/v1/chats"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({
      ok: false,
      error: { code: "UnauthorizedError", message: "Authentication required" },
    });
  });

  it("returns 400 with a safe validation message for an out-of-range limit", async () => {
    const req = await authedRequest("http://localhost/api/v1/chats?limit=9999");
    const res = await GET(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("ValidationError");
    expect(body.error.message).toMatch(/limit/i);
  });

  it("returns an empty list for a brand-new user", async () => {
    const req = await authedRequest("http://localhost/api/v1/chats");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.items).toEqual([]);
    expect(body.data.hasMore).toBe(false);
  });
});

describe("POST /api/v1/chats", () => {
  it("creates a chat and returns 201", async () => {
    const req = await authedRequest("http://localhost/api/v1/chats", {
      method: "POST",
      body: JSON.stringify({ title: "Route test chat" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.title).toBe("Route test chat");
  });

  it("returns 400 for an invalid body (empty-string title) with no internal leak", async () => {
    const req = await authedRequest("http://localhost/api/v1/chats", {
      method: "POST",
      body: JSON.stringify({ title: "" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("ValidationError");
    expect(JSON.stringify(body)).not.toMatch(/at\s+\w+\s+\(.*:\d+:\d+\)/); // no stack trace
  });

  it("creates a chat from an empty body (title is optional)", async () => {
    const req = await authedRequest("http://localhost/api/v1/chats", {
      method: "POST",
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.title).toBeNull();
  });
});
