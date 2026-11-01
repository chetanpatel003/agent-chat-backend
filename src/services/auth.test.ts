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
import { authenticate } from "./auth";
import { prisma } from "@/lib/prisma";
import { UnauthorizedError } from "@/lib/errors";

const mockVerifyToken = vi.mocked(verifyToken);
const mockGetUser = vi.mocked(clerkClient.users.getUser);

function makeRequest(headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/v1/me", { headers });
}

function mockClerkProfile(clerkUserId: string, email: string) {
  // Minimal shape of @clerk/backend's User resource — only the fields
  // resolveLocalUser() actually reads.
  return {
    id: clerkUserId,
    emailAddresses: [{ id: "em1", emailAddress: email }],
    primaryEmailAddressId: "em1",
    firstName: "Ada",
    lastName: "Lovelace",
    imageUrl: "https://img.example.com/a.png",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double, not the full Clerk User class
  } as any;
}

const createdUserIds: string[] = [];

beforeEach(() => {
  mockVerifyToken.mockReset();
  mockGetUser.mockReset();
});

afterAll(async () => {
  if (createdUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await prisma.$disconnect();
});

describe("authenticate — token verification", () => {
  it("throws UnauthorizedError when the Authorization header is missing", async () => {
    await expect(authenticate(makeRequest())).rejects.toThrow(UnauthorizedError);
    expect(mockVerifyToken).not.toHaveBeenCalled();
  });

  it("throws UnauthorizedError when the header isn't a Bearer token", async () => {
    await expect(
      authenticate(makeRequest({ Authorization: "Basic abc123" })),
    ).rejects.toThrow(UnauthorizedError);
  });

  it("throws UnauthorizedError when verifyToken rejects (invalid/expired token)", async () => {
    mockVerifyToken.mockRejectedValueOnce(new Error("invalid signature"));
    await expect(
      authenticate(makeRequest({ Authorization: "Bearer bad-token" })),
    ).rejects.toThrow(UnauthorizedError);
  });
});

describe("authenticate — local user resolution", () => {
  it("creates a local user on first sight of a valid Clerk identity", async () => {
    const clerkUserId = `test_ckpt1.2_${randomUUID()}`;
    mockVerifyToken.mockResolvedValueOnce({ sub: clerkUserId } as never);
    mockGetUser.mockResolvedValueOnce(
      mockClerkProfile(clerkUserId, "new-user@example.com"),
    );

    const ctx = await authenticate(
      makeRequest({ Authorization: "Bearer good-token" }),
    );
    createdUserIds.push(ctx.userId);

    expect(ctx.clerkUserId).toBe(clerkUserId);
    expect(ctx.user.email).toBe("new-user@example.com");
    expect(ctx.user.displayName).toBe("Ada Lovelace");
    expect(mockGetUser).toHaveBeenCalledTimes(1);

    const row = await prisma.user.findUnique({ where: { clerkUserId } });
    expect(row).not.toBeNull();
  });

  it("looks up an existing local user without calling Clerk's profile API again", async () => {
    const clerkUserId = `test_ckpt1.2_${randomUUID()}`;
    mockVerifyToken.mockResolvedValueOnce({ sub: clerkUserId } as never);
    mockGetUser.mockResolvedValueOnce(
      mockClerkProfile(clerkUserId, "existing@example.com"),
    );
    const first = await authenticate(makeRequest({ Authorization: "Bearer t1" }));
    createdUserIds.push(first.userId);
    mockGetUser.mockClear();

    mockVerifyToken.mockResolvedValueOnce({ sub: clerkUserId } as never);
    const second = await authenticate(makeRequest({ Authorization: "Bearer t2" }));

    expect(second.userId).toBe(first.userId);
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it("resolves concurrent first-sight requests for the same Clerk user to exactly one local row", async () => {
    const clerkUserId = `test_ckpt1.2_${randomUUID()}`;
    mockVerifyToken.mockResolvedValue({ sub: clerkUserId } as never);
    mockGetUser.mockResolvedValue(mockClerkProfile(clerkUserId, "race@example.com"));

    const [a, b, c] = await Promise.all([
      authenticate(makeRequest({ Authorization: "Bearer r1" })),
      authenticate(makeRequest({ Authorization: "Bearer r2" })),
      authenticate(makeRequest({ Authorization: "Bearer r3" })),
    ]);
    createdUserIds.push(a.userId);

    expect(a.userId).toBe(b.userId);
    expect(b.userId).toBe(c.userId);

    const count = await prisma.user.count({ where: { clerkUserId } });
    expect(count).toBe(1);
  });

  it("ignores any identity the caller tries to supply outside the verified token", async () => {
    const clerkUserId = `test_ckpt1.2_${randomUUID()}`;
    mockVerifyToken.mockResolvedValueOnce({ sub: clerkUserId } as never);
    mockGetUser.mockResolvedValueOnce(
      mockClerkProfile(clerkUserId, "honest@example.com"),
    );

    // authenticate() never reads anything but the Authorization header, so
    // a request trying to claim a different identity elsewhere has no
    // path to influence the result — the verified token's own subject is
    // what's used, every time.
    const spoofed = makeRequest({
      Authorization: "Bearer good-token",
      "x-user-id": "someone-elses-id",
    });
    const ctx = await authenticate(spoofed);
    createdUserIds.push(ctx.userId);

    expect(ctx.clerkUserId).toBe(clerkUserId);
    expect(ctx.clerkUserId).not.toBe("someone-elses-id");
  });
});
