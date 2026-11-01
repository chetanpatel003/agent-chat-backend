import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { ValidationError } from "@/lib/errors";
import { makeTestUser, cleanupTestUsers } from "@/test-utils/db-fixtures";
import { getBalance, listLedger } from "./credits";

const createdUserIds: string[] = [];
afterAll(() => cleanupTestUsers(createdUserIds));

async function user(label: string) {
  const u = await makeTestUser(label);
  createdUserIds.push(u.id);
  return u;
}

describe("getBalance", () => {
  it("reads 0 for a user with no CreditAccount row yet (none provisioned — out of scope this checkpoint)", async () => {
    const owner = await user("balance-none");
    const result = await getBalance(owner.id);
    expect(result.balance).toBe(0);
  });

  it("reads the real balance once an account exists", async () => {
    const owner = await user("balance-real");
    await prisma.creditAccount.create({ data: { userId: owner.id, balance: 1500 } });
    const result = await getBalance(owner.id);
    expect(result.balance).toBe(1500);
  });

  it("never reads another user's balance", async () => {
    const owner = await user("balance-isolation-owner");
    const other = await user("balance-isolation-other");
    await prisma.creditAccount.create({ data: { userId: owner.id, balance: 99999 } });

    const result = await getBalance(other.id);
    expect(result.balance).toBe(0);
  });
});

describe("listLedger", () => {
  async function seedLedger(userId: string, n: number, baseMs: number) {
    for (let i = 0; i < n; i++) {
      await prisma.creditLedger.create({
        data: {
          userId,
          amount: -100,
          type: "TOOL_CHARGE",
          idempotencyKey: `test_ckpt1.3_ledger_${randomUUID()}`,
          balanceAfter: 1000 - i * 100,
          description: `charge ${i}`,
          createdAt: new Date(baseMs - i * 1000),
        },
      });
    }
  }

  it("paginates deterministically, most recent first", async () => {
    const owner = await user("ledger-paginate");
    const base = new Date("2026-02-01T00:00:00.000Z").getTime();
    await seedLedger(owner.id, 3, base);

    const page1 = await listLedger(owner.id, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.items[0].description).toBe("charge 0"); // most recent
    expect(page1.hasMore).toBe(true);

    const page2 = await listLedger(owner.id, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0].description).toBe("charge 2");
    expect(page2.hasMore).toBe(false);
  });

  it("rejects an invalid cursor", async () => {
    const owner = await user("ledger-bad-cursor");
    await expect(listLedger(owner.id, { limit: 10, cursor: "nope" })).rejects.toThrow(
      ValidationError,
    );
  });

  it("never returns another user's ledger entries", async () => {
    const owner = await user("ledger-isolation-owner");
    const other = await user("ledger-isolation-other");
    await seedLedger(owner.id, 2, Date.now());

    const result = await listLedger(other.id, { limit: 20 });
    expect(result.items).toHaveLength(0);
  });
});
