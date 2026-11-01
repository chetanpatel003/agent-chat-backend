import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import type { AgentRunStatus } from "@/generated/prisma/enums";

/**
 * A single, focused guarded-transition primitive — not a state-machine
 * framework. Every AgentRun status write in the worker and the cancel
 * service goes through this, so a racing writer (a duplicate task
 * execution, a concurrent cancel request) can never overwrite a status
 * another process already moved on from: the update only applies while
 * the row's *current* status is still one of `from`; row count tells the
 * caller whether it actually won the race.
 */
export const ACTIVE_RUN_STATUSES: AgentRunStatus[] = ["QUEUED", "RUNNING", "WAITING"];

export type GuardedTransitionResult =
  | { applied: true }
  | { applied: false; currentStatus: AgentRunStatus };

export async function casAgentRunStatus(
  agentRunId: string,
  from: AgentRunStatus[],
  data: Prisma.AgentRunUpdateManyMutationInput,
): Promise<GuardedTransitionResult> {
  const result = await prisma.agentRun.updateMany({
    where: { id: agentRunId, status: { in: from } },
    data,
  });
  if (result.count > 0) return { applied: true };
  const current = await prisma.agentRun.findUniqueOrThrow({
    where: { id: agentRunId },
    select: { status: true },
  });
  return { applied: false, currentStatus: current.status };
}

export async function readAgentRunStatus(agentRunId: string): Promise<AgentRunStatus> {
  const current = await prisma.agentRun.findUniqueOrThrow({
    where: { id: agentRunId },
    select: { status: true },
  });
  return current.status;
}

/**
 * How long a lack of forward progress on an AgentRun must persist
 * before a re-entry check may conclude a previous attempt is
 * genuinely dead, rather than a sibling (or this very run) still
 * actively working. Every round of the tool-calling loop bumps
 * `AgentRun.updatedAt` (the `turnCount` write, before calling the
 * provider) and the initial CAS to RUNNING does too — a live
 * execution's `updatedAt` is never older than roughly one round's
 * worst-case duration (the provider's own request timeout plus tool-
 * execution/DB overhead). This reuses that existing write as a
 * liveness signal: no new column, no heartbeat loop, no lease table.
 * 120s gives comfortable margin over a single round's worst case
 * while staying far below the many-minutes a full multi-round
 * conversation could legitimately still be in progress for — see
 * `isAgentRunRecentlyActive`'s call sites in `run-agent-turn.ts` for
 * why detecting "maybe still alive" early matters more here than
 * detecting "definitely dead" instantly.
 */
export const STALE_RUN_LIVENESS_THRESHOLD_MS = 120_000;

/**
 * Distinguishes "a previous attempt crashed, genuinely abandoned" from
 * "a sibling (or this run itself, moments ago) is actively, legitimately
 * working on this right now" — the exact ambiguity a re-entry check
 * historically had no way to resolve (see API_CONTRACTS.md's "known,
 * accepted trade-off" from checkpoint 2.4, now closed). Returns `true`
 * when the row has been written to more recently than `thresholdMs`
 * ago — the caller's job is to back off without writing anything in
 * that case, not to guess who "wins."
 */
export async function isAgentRunRecentlyActive(
  agentRunId: string,
  thresholdMs: number = STALE_RUN_LIVENESS_THRESHOLD_MS,
): Promise<boolean> {
  const current = await prisma.agentRun.findUniqueOrThrow({
    where: { id: agentRunId },
    select: { updatedAt: true },
  });
  return Date.now() - current.updatedAt.getTime() < thresholdMs;
}

/**
 * Thrown inside a `$transaction` callback to roll it back when a guarded
 * sub-update inside it affected zero rows (the precondition it required
 * — e.g. the assistant message still being PENDING — was already false).
 * Caught at the call site; never escapes as a real error.
 */
export class SkippedTransition extends Error {}
