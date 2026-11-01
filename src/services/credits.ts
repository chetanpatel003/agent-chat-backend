import { prisma } from "@/lib/prisma";
import { ValidationError } from "@/lib/errors";
import { getOwnCreditAccount } from "@/services/ownership";
import { decodeCursor, encodeCursor } from "@/contracts/pagination";
import type {
  CreditBalanceResponse,
  CreditLedgerEntry,
  PaginatedCreditLedgerResponse,
} from "@/contracts/credits";
import type { CreditLedger, Prisma } from "@/generated/prisma/client";

function toLedgerEntry(entry: CreditLedger): CreditLedgerEntry {
  return {
    id: entry.id,
    amount: Number(entry.amount),
    type: entry.type,
    balanceAfter: Number(entry.balanceAfter),
    description: entry.description,
    toolInvocationId: entry.toolInvocationId,
    createdAt: entry.createdAt.toISOString(),
  };
}

/** No charging/settlement exists yet (explicitly out of scope for this
 * checkpoint), so most users have no CreditAccount row at all. A GET
 * never has a side effect — a missing account reads as a balance of 0,
 * it is not auto-provisioned here. */
export async function getBalance(userId: string): Promise<CreditBalanceResponse> {
  const account = await getOwnCreditAccount(userId);
  return { balance: Number(account?.balance ?? BigInt(0)) };
}

export async function listLedger(
  userId: string,
  opts: { cursor?: string; limit: number },
): Promise<PaginatedCreditLedgerResponse> {
  const decoded = opts.cursor ? decodeCursor(opts.cursor) : null;
  if (opts.cursor && !decoded) {
    throw new ValidationError("Invalid cursor");
  }

  const where: Prisma.CreditLedgerWhereInput = { userId };
  if (decoded) {
    const cursorDate = new Date(decoded.sortKey);
    where.OR = [
      { createdAt: { lt: cursorDate } },
      { createdAt: cursorDate, id: { lt: decoded.id } },
    ];
  }

  const rows = await prisma.creditLedger.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: opts.limit + 1,
  });

  const hasMore = rows.length > opts.limit;
  const page = rows.slice(0, opts.limit);
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({ sortKey: last.createdAt.toISOString(), id: last.id })
      : null;

  return { items: page.map(toLedgerEntry), nextCursor, hasMore };
}
