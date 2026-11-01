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
 * Thrown inside a `$transaction` callback to roll it back when a guarded
 * sub-update inside it affected zero rows (the precondition it required
 * — e.g. the assistant message still being PENDING — was already false).
 * Caught at the call site; never escapes as a real error.
 */
export class SkippedTransition extends Error {}
