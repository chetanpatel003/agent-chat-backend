import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { makeTestUser, cleanupTestUsers } from "@/test-utils/db-fixtures";
import type { AgentRunStatus } from "@/generated/prisma/enums";
import { sweepStaleRuns, STALE_ACTIVE_RUN_THRESHOLD_MS, type StaleRunRecoveryDeps } from "./stale-run-recovery";

// The sweep runs against the shared dev database, so every injected status
// function reports "EXECUTING" (live, never touched) for any run these tests
// did not create.

const createdUserIds: string[] = [];
afterAll(() => cleanupTestUsers(createdUserIds));

const STALE_AGE_MS = STALE_ACTIVE_RUN_THRESHOLD_MS + 60_000;

async function activeRun(
  label: string,
  opts: { status?: AgentRunStatus; ageMs?: number; triggerRunId?: string | null; waitpoint?: boolean } = {},
) {
  const owner = await makeTestUser(label);
  createdUserIds.push(owner.id);
  const chat = await prisma.chat.create({ data: { userId: owner.id } });
  const triggerRunId = opts.triggerRunId === undefined ? `run_test_${randomUUID()}` : opts.triggerRunId;
  const run = await prisma.agentRun.create({
    data: {
      chatId: chat.id,
      userId: owner.id,
      idempotencyKey: randomUUID(),
      status: opts.status ?? "RUNNING",
      waitingReason: opts.status === "WAITING" ? "PLAN" : null,
      triggerRunId,
      startedAt: new Date(),
    },
  });
  const message = await prisma.message.create({
    data: {
      chatId: chat.id,
      userId: owner.id,
      agentRunId: run.id,
      role: "ASSISTANT",
      status: "PENDING",
      content: [{ type: "text", text: "partial reply" }],
    },
  });
  const waitpoint = opts.waitpoint
    ? await prisma.waitpoint.create({
        data: {
          agentRunId: run.id,
          type: "PLAN",
          token: `tok_${randomUUID()}`,
          idempotencyKey: randomUUID(),
          payload: { plan: "p" },
          expiresAt: new Date(Date.now() + 3600_000),
        },
      })
    : null;
  if (opts.ageMs !== 0) {
    const age = opts.ageMs ?? STALE_AGE_MS;
    await prisma.$executeRaw`UPDATE "AgentRun" SET "updatedAt" = ${new Date(Date.now() - age)} WHERE "id" = ${run.id}::uuid`;
  }
  return { run, message, waitpoint, triggerRunId };
}

/** Reports the given status only for the given runs; everything else is live. */
function statuses(map: Record<string, string>): StaleRunRecoveryDeps {
  return { triggerRunStatus: async (id) => map[id] ?? "EXECUTING" };
}

const readRun = (id: string) => prisma.agentRun.findUniqueOrThrow({ where: { id } });

describe("sweepStaleRuns", () => {
  it("recovers a stale RUNNING run whose Trigger.dev run has finished: FAILED with a retry hint, content kept, no provider call", async () => {
    const { run, message, triggerRunId } = await activeRun("stale-run-recover");
    const summary = await sweepStaleRuns(statuses({ [triggerRunId!]: "COMPLETED" }));
    expect(summary.recovered).toBeGreaterThanOrEqual(1);

    expect(await readRun(run.id)).toMatchObject({ status: "FAILED", errorCode: "RUN_INTERRUPTED", waitingReason: null });
    const msg = await prisma.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(msg.content).toEqual([{ type: "text", text: "partial reply" }]);
  });

  it.each(["CRASHED", "SYSTEM_FAILURE", "FAILED", "CANCELED", "TIMED_OUT", "EXPIRED"])(
    "treats Trigger.dev status %s as finished",
    async (status) => {
      const { run, triggerRunId } = await activeRun(`stale-run-${status.toLowerCase()}`);
      await sweepStaleRuns(statuses({ [triggerRunId!]: status }));
      expect((await readRun(run.id)).status).toBe("FAILED");
    },
  );

  it.each(["EXECUTING", "QUEUED", "DEQUEUED", "WAITING", "DELAYED", "PENDING_VERSION"])(
    "never touches a run Trigger.dev still reports as %s, however old its updatedAt",
    async (status) => {
      const { run, triggerRunId } = await activeRun(`live-run-${status.toLowerCase()}`, { ageMs: 24 * 3600_000 });
      await sweepStaleRuns(statuses({ [triggerRunId!]: status }));
      expect((await readRun(run.id)).status).toBe("RUNNING");
    },
  );

  it("does not consider a recently updated run at all", async () => {
    const { run, triggerRunId } = await activeRun("stale-run-recent", { ageMs: 0 });
    const checkedIds: string[] = [];
    await sweepStaleRuns({
      triggerRunStatus: async (id) => {
        checkedIds.push(id);
        return id === triggerRunId ? "COMPLETED" : "EXECUTING";
      },
    });
    expect(checkedIds).not.toContain(triggerRunId);
    expect((await readRun(run.id)).status).toBe("RUNNING");
  });

  it("leaves a run without a recorded Trigger.dev run, and one whose status can't be read, for later", async () => {
    const noTrigger = await activeRun("stale-run-no-trigger", { triggerRunId: null });
    const unreadable = await activeRun("stale-run-unreadable");
    await sweepStaleRuns({
      triggerRunStatus: async (id) => {
        if (id === unreadable.triggerRunId) throw new Error("Trigger.dev unavailable");
        return "EXECUTING";
      },
    });
    expect((await readRun(noTrigger.run.id)).status).toBe("RUNNING");
    expect((await readRun(unreadable.run.id)).status).toBe("RUNNING");
  });

  it("never overwrites a newer write: a run that progressed (or completed) after it was judged stale is left alone", async () => {
    const progressed = await activeRun("stale-run-race-progress");
    const completed = await activeRun("stale-run-race-complete");
    await sweepStaleRuns({
      triggerRunStatus: async (id) => {
        // Between the sweep's read and its write: a live execution writes progress,
        // another finishes the run successfully.
        if (id === progressed.triggerRunId) {
          await prisma.agentRun.update({ where: { id: progressed.run.id }, data: { turnCount: 2 } });
          return "COMPLETED";
        }
        if (id === completed.triggerRunId) {
          await prisma.agentRun.update({ where: { id: completed.run.id }, data: { status: "COMPLETED", completedAt: new Date() } });
          return "COMPLETED";
        }
        return "EXECUTING";
      },
    });
    expect((await readRun(progressed.run.id)).status).toBe("RUNNING");
    expect(await readRun(completed.run.id)).toMatchObject({ status: "COMPLETED", errorCode: null });
  });

  it("recovers a stale WAITING run whose worker is gone and cancels its open waitpoint", async () => {
    const { run, waitpoint, triggerRunId } = await activeRun("stale-run-waiting", { status: "WAITING", waitpoint: true });
    await sweepStaleRuns(statuses({ [triggerRunId!]: "CRASHED" }));
    expect(await readRun(run.id)).toMatchObject({ status: "FAILED", waitingReason: null });
    expect((await prisma.waitpoint.findUniqueOrThrow({ where: { id: waitpoint!.id } })).status).toBe("CANCELLED");
  });

  it("is idempotent and safe under concurrent sweeps: one recovery, terminal rows untouched afterwards", async () => {
    const { run, triggerRunId } = await activeRun("stale-run-concurrent");
    const deps = statuses({ [triggerRunId!]: "COMPLETED" });
    await Promise.all([sweepStaleRuns(deps), sweepStaleRuns(deps), sweepStaleRuns(deps)]);
    const after = await readRun(run.id);
    expect(after.status).toBe("FAILED");

    await sweepStaleRuns(deps); // a later sweep: no longer a candidate
    expect((await readRun(run.id)).updatedAt).toEqual(after.updatedAt);
  });
});
