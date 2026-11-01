import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@clerk/backend", () => ({
  verifyToken: vi.fn(),
}));
vi.mock("@/lib/clerk", () => ({
  clerkClient: { users: { getUser: vi.fn() } },
}));

import { verifyToken } from "@clerk/backend";
import { clerkClient } from "@/lib/clerk";
import { GET } from "./route";
import { prisma } from "@/lib/prisma";

const mockVerifyToken = vi.mocked(verifyToken);
const mockGetUser = vi.mocked(clerkClient.users.getUser);

const createdUserIds: string[] = [];

beforeEach(() => {
  mockVerifyToken.mockReset();
  mockGetUser.mockReset();
});

afterAll(async () => {
  if (createdUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
});

function makeRequest(headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/v1/me", { headers });
}

describe("GET /api/v1/me", () => {
  it("returns 401 with no leaked detail when the token is missing", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("UnauthorizedError");
    expect(JSON.stringify(body)).not.toMatch(/at\s+\w+\s+\(.*:\d+:\d+\)/); // no stack trace
  });

  it("returns 401 when the token fails verification", async () => {
    mockVerifyToken.mockRejectedValueOnce(new Error("expired"));
    const res = await GET(makeRequest({ Authorization: "Bearer bad" }));
    expect(res.status).toBe(401);
  });

  it("returns 200 with the authenticated user's profile for a valid token", async () => {
    const clerkUserId = `test_ckpt1.2_route_${randomUUID()}`;
    mockVerifyToken.mockResolvedValueOnce({ sub: clerkUserId } as never);
    mockGetUser.mockResolvedValueOnce({
      id: clerkUserId,
      emailAddresses: [{ id: "em1", emailAddress: "route-test@example.com" }],
      primaryEmailAddressId: "em1",
      firstName: "Grace",
      lastName: "Hopper",
      imageUrl: "https://img.example.com/g.png",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double
    } as any);

    const res = await GET(makeRequest({ Authorization: "Bearer good" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.email).toBe("route-test@example.com");
    expect(body.data.displayName).toBe("Grace Hopper");
    createdUserIds.push(body.data.id);
  });
});
