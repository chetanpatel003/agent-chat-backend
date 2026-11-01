import { verifyToken } from "@clerk/backend";
import { prisma } from "@/lib/prisma";
import { clerkClient } from "@/lib/clerk";
import { UnauthorizedError } from "@/lib/errors";
import { Prisma, type User } from "@/generated/prisma/client";

export type AuthContext = {
  /** Local User.id (uuid) — every ownership check and FK uses this, never
   * the Clerk id directly. */
  userId: string;
  clerkUserId: string;
  /** Full row, so a handler that needs profile fields (e.g. /me) doesn't
   * have to issue a second query right after this one resolved it. */
  user: User;
};

function extractBearerToken(request: Request): string {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) {
    throw new UnauthorizedError();
  }
  const token = header.slice("Bearer ".length).trim();
  if (!token) throw new UnauthorizedError();
  return token;
}

function authorizedParties(): string[] {
  const origin = process.env.FRONTEND_ORIGIN;
  return origin ? [origin] : [];
}

async function resolveLocalUser(clerkUserId: string): Promise<User> {
  // Fast path: no Clerk API call on the hot path for a user we already
  // know about — this runs on every authenticated request.
  const existing = await prisma.user.findUnique({ where: { clerkUserId } });
  if (existing) return existing;

  // First time we've seen this Clerk user locally. Fetch their profile
  // once to populate the required fields, then create.
  const profile = await clerkClient.users.getUser(clerkUserId);
  const primaryEmail =
    profile.emailAddresses.find((e) => e.id === profile.primaryEmailAddressId)
      ?.emailAddress ?? profile.emailAddresses[0]?.emailAddress;

  if (!primaryEmail) {
    // The User.email column is NOT NULL. Shouldn't happen for a Clerk
    // instance requiring an email, but fail loudly instead of writing a
    // row we can't actually use.
    throw new UnauthorizedError("Account has no verified email address");
  }

  // Safe under a concurrent-request race via Postgres's unique constraint
  // on clerkUserId, NOT via prisma.user.upsert(): Prisma's upsert emulates
  // the check-then-act itself (SELECT, then conditional INSERT/UPDATE) —
  // it is not a single atomic `INSERT ... ON CONFLICT`, so two upserts
  // racing for the same new clerkUserId can both see "not found" and one
  // throws a real unique-constraint error rather than resolving. create()
  // throwing P2002 is the actual database-level guarantee; the loser of
  // the race just re-reads the row the winner created.
  try {
    return await prisma.user.create({
      data: {
        clerkUserId,
        email: primaryEmail,
        displayName:
          [profile.firstName, profile.lastName].filter(Boolean).join(" ") ||
          null,
        imageUrl: profile.imageUrl || null,
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const winner = await prisma.user.findUnique({ where: { clerkUserId } });
      if (winner) return winner;
    }
    throw error;
  }
}

/**
 * Centralized entry point every authenticated route handler calls first.
 * Verifies the bearer token against Clerk, then resolves (or creates) the
 * local user row. Throws UnauthorizedError on any failure — route handlers
 * catch it via lib/errors#toErrorResponse and always return a 401 with no
 * internal detail, never a token/validation internals leak.
 *
 * The frontend never supplies a user id anywhere this function looks —
 * identity comes only from the verified token's `sub` claim.
 */
export async function authenticate(request: Request): Promise<AuthContext> {
  const token = extractBearerToken(request);

  let claims: Awaited<ReturnType<typeof verifyToken>>;
  try {
    claims = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY,
      authorizedParties: authorizedParties(),
    });
  } catch {
    throw new UnauthorizedError();
  }

  const clerkUserId = claims.sub;
  const user = await resolveLocalUser(clerkUserId);

  return { userId: user.id, clerkUserId, user };
}
