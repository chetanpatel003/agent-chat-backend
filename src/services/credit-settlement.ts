import { prisma } from "@/lib/prisma";

// Exactly-once settlement of a terminal Magica ToolInvocation against the
// user's CreditAccount, using Magica's own terminal `creditUsed` as the
// charge — raw integer units (the same unit as `estimate-credits` and the
// Magica balance), no division, no multiplier. OpenRouter turns are never
// settled: only the Magica tools below are billable.
//
// Concurrency/idempotency (database-enforced, not read-before-write):
//  1. the user's CreditAccount row is locked (SELECT … FOR UPDATE);
//  2. the invocation is claimed with a guarded update (creditsCharged IS NULL);
//  3. the ledger row carries the unique idempotencyKey `tool-charge:{id}`.
// A duplicate/concurrent attempt finds the claim taken and changes nothing.
// The balance never goes negative (also a DB CHECK constraint): at most the
// available balance is debited. Actual usage is ToolInvocation.creditsUsed,
// the amount collected is creditsCharged; the difference is the shortfall.

export const BILLABLE_TOOL_NAMES = ["generate_image", "edit_image", "crop_image", "merge_videos"] as const;
const BILLABLE_MAGICA_TOOLS: ReadonlySet<string> = new Set(BILLABLE_TOOL_NAMES);

export function isBillableTool(toolName: string): boolean {
  return BILLABLE_MAGICA_TOOLS.has(toolName);
}

export type SettlementResult =
  | { status: "settled"; creditUsed: bigint; charged: bigint; shortfall: bigint }
  | { status: "already_settled" }
  | { status: "not_billable" }
  | { status: "no_usage_reported" };

export function settlementIdempotencyKey(toolInvocationId: string): string {
  return `tool-charge:${toolInvocationId}`;
}

/** The provider's reported raw usage persisted on the invocation's output. */
export function reportedCreditUsed(output: unknown): bigint | null {
  const value = output && typeof output === "object" ? (output as { creditUsed?: unknown }).creditUsed : undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
}

export async function settleToolInvocationCredits(toolInvocationId: string): Promise<SettlementResult> {
  const invocation = await prisma.toolInvocation.findUnique({
    where: { id: toolInvocationId },
    include: { agentRun: { select: { userId: true } } },
  });
  if (!invocation || !BILLABLE_MAGICA_TOOLS.has(invocation.toolName)) return { status: "not_billable" };
  if (invocation.status !== "COMPLETED" && invocation.status !== "FAILED") return { status: "not_billable" };
  if (invocation.creditsCharged !== null) return { status: "already_settled" };

  const creditUsed = reportedCreditUsed(invocation.output);
  if (creditUsed === null) {
    // FAILED before any provider run started, or the provider reported nothing:
    // nothing to charge, left unsettled rather than guessed.
    return { status: "no_usage_reported" };
  }

  const userId = invocation.agentRun.userId;
  return prisma.$transaction(async (tx) => {
    // Creating a zero-balance account is not a grant; it gives the lock a row.
    await tx.creditAccount.createMany({ data: [{ userId }], skipDuplicates: true });
    const [account] = await tx.$queryRaw<{ balance: bigint }[]>`
      SELECT "balance" FROM "CreditAccount" WHERE "userId" = ${userId}::uuid FOR UPDATE`;
    const balance = account.balance;
    const charged = creditUsed <= balance ? creditUsed : balance;
    const shortfall = creditUsed - charged;

    // Actual usage and the amount collected are stored separately; their
    // difference is the machine-readable outstanding shortfall. A CHECK
    // constraint enforces 0 <= creditsCharged <= creditsUsed.
    const claim = await tx.toolInvocation.updateMany({
      where: { id: toolInvocationId, creditsCharged: null },
      data: { creditsUsed: creditUsed, creditsCharged: charged },
    });
    if (claim.count === 0) return { status: "already_settled" } as const;

    if (creditUsed > BigInt(0)) {
      const balanceAfter = balance - charged;
      if (charged > BigInt(0)) {
        await tx.creditAccount.update({ where: { userId }, data: { balance: balanceAfter } });
      }
      await tx.creditLedger.create({
        data: {
          userId,
          amount: -charged,
          type: "TOOL_CHARGE",
          idempotencyKey: settlementIdempotencyKey(toolInvocationId),
          toolInvocationId,
          balanceAfter,
          description:
            `${invocation.toolName} (${invocation.status.toLowerCase()}): ${creditUsed} credits used` +
            (shortfall > BigInt(0) ? `; ${shortfall} not recovered (insufficient balance)` : ""),
        },
      });
    }
    return { status: "settled", creditUsed, charged, shortfall } as const;
  }, SETTLEMENT_TRANSACTION_OPTIONS);
}

/** Concurrent settlements for one user queue on the account row lock; Prisma's
 * defaults (2s to start, 5s total) are too tight for that over a remote DB. */
const SETTLEMENT_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;

/** Never throws: settlement failure must not change a tool's recorded outcome. */
export async function settleToolInvocationCreditsSafely(toolInvocationId: string): Promise<SettlementResult | null> {
  try {
    return await settleToolInvocationCredits(toolInvocationId);
  } catch (error) {
    console.error("Credit settlement failed; will be retried by run recovery", {
      toolInvocationId,
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return null;
  }
}

/** Raw credits used but not collected, summed over a user's settled invocations. */
export async function outstandingShortfall(userId: string): Promise<bigint> {
  const [row] = await prisma.$queryRaw<{ shortfall: bigint | null }[]>`
    SELECT SUM(ti."creditsUsed" - ti."creditsCharged")::bigint AS shortfall
    FROM "ToolInvocation" ti JOIN "AgentRun" ar ON ar."id" = ti."agentRunId"
    WHERE ar."userId" = ${userId}::uuid AND ti."creditsCharged" IS NOT NULL`;
  return row?.shortfall ?? BigInt(0);
}

/** Recovery: settles every terminal billable invocation of a run not yet settled. */
export async function settleRunCredits(agentRunId: string): Promise<void> {
  const pending = await prisma.toolInvocation
    .findMany({
      where: {
        agentRunId,
        status: { in: ["COMPLETED", "FAILED"] },
        creditsCharged: null,
        toolName: { in: [...BILLABLE_MAGICA_TOOLS] },
      },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    })
    .catch(() => []);
  for (const { id } of pending) await settleToolInvocationCreditsSafely(id);
}
