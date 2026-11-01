import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@clerk/backend", () => ({ verifyToken: vi.fn() }));
vi.mock("@/lib/clerk", () => ({ clerkClient: { users: { getUser: vi.fn() } } }));

import { verifyToken } from "@clerk/backend";
import { clerkClient } from "@/lib/clerk";
import { GET, PATCH } from "./route";
import { prisma } from "@/lib/prisma";
import { cleanupTestUsers } from "@/test-utils/db-fixtures";

const mockVerifyToken = vi.mocked(verifyToken);
const mockGetUser = vi.mocked(clerkClient.users.getUser);
const CLERK_ID_PREFIX = "test_ckpt1.3_chatid_route_";

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

describe("GET/PATCH /api/v1/chats/[chatId] — cross-user and happy path", () => {
  it("rejects a different user with 404, not 403 — identical to a nonexistent chat", async () => {
    const ownerClerkId = `${CLERK_ID_PREFIX}owner_${randomUUID()}`;
    const intruderClerkId = `${CLERK_ID_PREFIX}intruder_${randomUUID()}`;

    // Owner provisioned directly — only the request(s) actually exercised
    // through the route below need a queued Clerk mock.
    const owner = await prisma.user.create({
      data: { clerkUserId: ownerClerkId, email: `${ownerClerkId}@example.com` },
    });
    const chat = await prisma.chat.create({ data: { userId: owner.id, title: "secret" } });

    const req = await authedRequestAs(
      intruderClerkId,
      `http://localhost/api/v1/chats/${chat.id}`,
    );
    const res = await GET(req, routeCtx(chat.id));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("NotFoundError");

    // Same response shape as a chat id that was never real.
    const req2 = await authedRequestAs(
      intruderClerkId,
      `http://localhost/api/v1/chats/${randomUUID()}`,
    );
    const res2 = await GET(req2, routeCtx(randomUUID()));
    expect(res2.status).toBe(404);
    const body2 = await res2.json();
    expect(body2).toEqual(body);
  });

  it("the owner can PATCH their own chat", async () => {
    const ownerClerkId = `${CLERK_ID_PREFIX}patch_owner_${randomUUID()}`;
    const owner = await prisma.user.upsert({
      where: { clerkUserId: ownerClerkId },
      create: { clerkUserId: ownerClerkId, email: `${ownerClerkId}@example.com` },
      update: {},
    });
    const chat = await prisma.chat.create({ data: { userId: owner.id, title: "old" } });

    const req = await authedRequestAs(
      ownerClerkId,
      `http://localhost/api/v1/chats/${chat.id}`,
      { method: "PATCH", body: JSON.stringify({ title: "new" }) },
    );
    const res = await PATCH(req, routeCtx(chat.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.title).toBe("new");
  });
});
