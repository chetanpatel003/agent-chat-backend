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

function createPrismaClient() {
  const pool =
    globalForPrisma.pgPool ??
    new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
    });
  globalForPrisma.pgPool = pool;

  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
