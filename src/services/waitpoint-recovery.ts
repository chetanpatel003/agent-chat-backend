import { prisma } from "@/lib/prisma";
import { ensureTokenCompleted, expireWaitpoint, type WaitpointTokenClient } from "@/services/waitpoint";

// Scheduled safety net for human waitpoints. The worker normally handles
// both cases itself (token timeout → expire; completion → resume); this
// covers a worker that is gone and a token completion that failed after
// the decision was committed and was never retried by the client.

/** After expiresAt, the worker's own token timeout gets this long first. */
export const WAITPOINT_EXPIRY_GRACE_MS = 5 * 60_000;
/** A decision saved this long ago whose run is still WAITING was not delivered. */
export const RESOLVED_DELIVERY_GRACE_MS = 60_000;
export const WAITPOINT_RECOVERY_BATCH_SIZE = 25;

export type WaitpointRecoveryDeps = {
  client: WaitpointTokenClient;
  cancelTriggerRun: (triggerRunId: string | null, log: Record<string, unknown>) => Promise<void>;
};

export type WaitpointRecoverySummary = { expired: number; redelivered: number; redeliveryFailed: number };

export async function sweepWaitpoints(deps: WaitpointRecoveryDeps, now = new Date()): Promise<WaitpointRecoverySummary> {
  const summary: WaitpointRecoverySummary = { expired: 0, redelivered: 0, redeliveryFailed: 0 };

  // 1. Unanswered past expiry: expire, stop the run (content kept), end the suspended task.
  const overdue = await prisma.waitpoint.findMany({
    where: { status: "PENDING", expiresAt: { lt: new Date(now.getTime() - WAITPOINT_EXPIRY_GRACE_MS) } },
    orderBy: { expiresAt: "asc" },
    take: WAITPOINT_RECOVERY_BATCH_SIZE,
    select: { id: true, token: true, agentRun: { select: { id: true, triggerRunId: true } } },
  });
  for (const wp of overdue) {
    if (await expireWaitpoint(wp.id)) {
      summary.expired++;
      await deps.cancelTriggerRun(wp.agentRun.triggerRunId, {
        agentRunId: wp.agentRun.id,
        waitpointId: wp.id,
        waitpointTokenId: wp.token,
      });
    }
  }

  // 2. Decided but never delivered: complete the same token (at most once).
  const undelivered = await prisma.waitpoint.findMany({
    where: {
      status: "RESOLVED",
      resolvedAt: { lt: new Date(now.getTime() - RESOLVED_DELIVERY_GRACE_MS) },
      agentRun: { status: "WAITING" },
    },
    orderBy: { resolvedAt: "asc" },
    take: WAITPOINT_RECOVERY_BATCH_SIZE,
    select: { id: true, token: true, resolution: true, agentRunId: true },
  });
  for (const wp of undelivered) {
    try {
      const outcome = await ensureTokenCompleted(wp, deps.client);
      if (outcome === "completed") summary.redelivered++;
    } catch (error) {
      summary.redeliveryFailed++; // the next sweep retries
      console.error("Waitpoint recovery: token completion failed", {
        agentRunId: wp.agentRunId,
        waitpointId: wp.id,
        waitpointTokenId: wp.token,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return summary;
}
