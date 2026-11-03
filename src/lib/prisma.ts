import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

// Runtime client uses the pooled Neon URL (PgBouncer-style). The CLI
// (migrate/validate) uses the direct URL instead — see prisma.config.ts and
// project-docs/DATABASE.md. Bounded pool size: this is a serverless API
// route handler, not a long-lived server, so connections must stay low
// relative to Neon's pooler limits even under concurrent invocations.
const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  pgPool?: Pool;
};

/** Connections per process: `DATABASE_POOL_MAX` (1–50), default 10. Keep it
 * small for many short-lived serverless instances; a long-lived worker
 * handling many concurrent turns can use more (see project-docs/LOAD_TEST.md). */
function poolMax(): number {
  const configured = Number(process.env.DATABASE_POOL_MAX);
  return Number.isInteger(configured) && configured >= 1 && configured <= 50 ? configured : 10;
}

function createPrismaClient() {
  const pool =
    globalForPrisma.pgPool ??
    new Pool({
      connectionString: process.env.DATABASE_URL,
      max: poolMax(),
    });
  globalForPrisma.pgPool = pool;

  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
