import { wait } from "@trigger.dev/sdk";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import type { Waitpoint } from "@/generated/prisma/client";
import type { WaitpointType } from "@/generated/prisma/enums";
import {
  ConflictError,
  ExecutionStatusUnavailableError,
  NotFoundError,
  RunInterruptedError,
  ValidationError,
} from "@/lib/errors";
import {
  FINISHED_TRIGGER_RUN_STATUSES,
  LIVE_TRIGGER_RUN_STATUSES,
  interruptRun,
  triggerRunStatus,
} from "@/services/stale-run-recovery";
import { requireAgentRunOwnership, requireChatOwnership } from "@/services/ownership";
import {
  ACTIVE_RUN_STATUSES,
  casAgentRunStatus,
  RUN_TRANSITION_TRANSACTION_OPTIONS,
  SkippedTransition,
} from "@/services/run-transitions";
import type { EmitRunEvent } from "@/realtime/publish-run-event";
import {
  waitpointDefinition,
  type SupportedWaitpointType,
  type WaitpointListResponse,
  type WaitpointResponse,
} from "@/contracts/waitpoint";

// Human waitpoints: the Waitpoint row is the durable source of truth; a
// Trigger.dev waitpoint token is what the run suspends on (no compute while
// waiting). Ordering rules that make resumption exactly-once:
//  - the token is created with the row's idempotency key, so a retried
//    attempt gets the same token and the same row;
//  - a decision is committed to PostgreSQL first (guarded PENDING ->
//    RESOLVED), and only then is the token completed; a token is completed
//    at most once (its status is checked first), so repeating the request
//    after a failed completion completes the same token, never a new one;
//  - the run resumes through a guarded WAITING -> RUNNING transition, and
//    reads the decision from the row, not from the token.

export const WAITPOINT_EXPIRED_CODE = "WAITPOINT_EXPIRED";
export const WAITPOINT_EXPIRED_MESSAGE =
  "This plan wasn't approved within 24 hours, so the run was stopped. Send a new message to continue.";

/** Inside a task: create and wait on Trigger.dev tokens (injected in tests). */
export type WaitpointRuntime = {
  createToken(options: { idempotencyKey: string; timeoutMs: number }): Promise<{ id: string }>;
  /** Resolves when the token completes ({ ok: true }) or times out ({ ok: false }). */
  forToken(tokenId: string): Promise<{ ok: boolean }>;
};

export const triggerWaitpointRuntime: WaitpointRuntime = {
  async createToken({ idempotencyKey, timeoutMs }) {
    const token = await wait.createToken({
      idempotencyKey,
      // Longer than the wait itself, so a retry within the window reuses the token.
      idempotencyKeyTTL: "48h",
      timeout: new Date(Date.now() + timeoutMs),
    });
    return { id: token.id };
  },
  async forToken(tokenId) {
    const result = await wait.forToken(tokenId);
    return { ok: result.ok };
  },
};

/** Outside a task (API, recovery sweep): inspect and complete tokens. */
export type WaitpointTokenClient = {
  status(tokenId: string): Promise<"WAITING" | "COMPLETED" | "TIMED_OUT">;
  complete(tokenId: string, data: unknown): Promise<void>;
};

export const triggerWaitpointTokenClient: WaitpointTokenClient = {
  async status(tokenId) {
    return (await wait.retrieveToken(tokenId)).status;
  },
  async complete(tokenId, data) {
    await wait.completeToken(tokenId, data);
  },
};

/** The decision was saved but the run could not be resumed yet; retrying resumes it. */
export class WaitpointResumeError extends Error {
  constructor() {
    super("Your decision was saved, but the run couldn't be resumed yet. Try again in a moment.");
    this.name = "WaitpointResumeError";
  }
}

export function waitpointIdempotencyKey(agentRunId: string, round: number, type: WaitpointType): string {
  return `waitpoint:${agentRunId}:${round}:${type}`;
}

function toWaitpointResponse(row: Waitpoint): WaitpointResponse {
  return {
    id: row.id,
    agentRunId: row.agentRunId,
    type: row.type,
    status: row.status,
    payload: row.payload as Record<string, unknown>,
    resolution: (row.resolution as Record<string, unknown> | null) ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export type WaitpointOutcome<T> =
  | { status: "resolved"; resolution: T }
  | { status: "expired" }
  /** The run stopped being ours (cancelled, interrupted, finalized elsewhere). */
  | { status: "inactive" };

/**
 * Inside the agent task: opens (or re-opens, idempotently) a waitpoint,
 * moves the run to WAITING, suspends on its token, and returns the
 * decision read from PostgreSQL.
 */
export async function awaitWaitpoint<T extends SupportedWaitpointType>(params: {
  agentRunId: string;
  type: T;
  round: number;
  payload: unknown;
  runtime: WaitpointRuntime;
  emit: EmitRunEvent;
}): Promise<WaitpointOutcome<Record<string, unknown>>> {
  const { agentRunId, type, round, runtime, emit } = params;
  const definition = waitpointDefinition(type);
  if (!definition) throw new Error(`Unsupported waitpoint type ${type}`);
  const payload = definition.payloadSchema.parse(params.payload);
  const idempotencyKey = waitpointIdempotencyKey(agentRunId, round, type);

  let row = await prisma.waitpoint.findUnique({ where: { idempotencyKey } });
  if (!row) {
    const token = await runtime.createToken({ idempotencyKey, timeoutMs: definition.timeoutMs });
    try {
      row = await prisma.waitpoint.create({
        data: {
          agentRunId,
          type,
          token: token.id,
          idempotencyKey,
          payload: payload as Prisma.InputJsonValue,
          expiresAt: new Date(Date.now() + definition.timeoutMs),
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      row = await prisma.waitpoint.findUniqueOrThrow({ where: { idempotencyKey } });
    }
  }
  const log = { agentRunId, waitpointId: row.id, waitpointTokenId: row.token, type };

  if (row.status === "PENDING") {
    const toWaiting = await casAgentRunStatus(agentRunId, ["RUNNING", "WAITING"], {
      status: "WAITING",
      waitingReason: type,
    });
    if (!toWaiting.applied) {
      await prisma.waitpoint.updateMany({ where: { id: row.id, status: "PENDING" }, data: { status: "CANCELLED" } });
      return { status: "inactive" };
    }
    console.info("Waitpoint opened", log);
    await emit({ type: "run_status", status: "WAITING" });
    await emit({ type: "step", step: "waiting", round });
    await emit({ type: "waitpoint", waitpointId: row.id, waitpointType: type, status: "PENDING" });

    const result = await runtime.forToken(row.token);
    console.info("Waitpoint token returned", { ...log, ok: result.ok });
    row = await prisma.waitpoint.findUniqueOrThrow({ where: { id: row.id } });
    // The token timed out and nobody decided: expire (guarded; the sweep may race).
    if (row.status === "PENDING" && !result.ok) {
      await expireWaitpoint(row.id);
      row = await prisma.waitpoint.findUniqueOrThrow({ where: { id: row.id } });
    }
  }

  if (row.status === "EXPIRED") {
    await emit({ type: "waitpoint", waitpointId: row.id, waitpointType: type, status: "EXPIRED" });
    return { status: "expired" };
  }
  if (row.status !== "RESOLVED") return { status: "inactive" };

  // RESOLVED in PostgreSQL is authoritative even if the token timed out
  // after the decision was saved (its completion had failed).
  const resolution = definition.resolutionSchema.safeParse(row.resolution);
  if (!resolution.success) throw new Error(`Waitpoint ${row.id} has an invalid stored resolution`);
  const toRunning = await casAgentRunStatus(agentRunId, ["WAITING", "RUNNING"], {
    status: "RUNNING",
    waitingReason: null,
  });
  if (!toRunning.applied) return { status: "inactive" };
  await emit({ type: "waitpoint", waitpointId: row.id, waitpointType: type, status: "RESOLVED" });
  await emit({ type: "run_status", status: "RUNNING" });
  return { status: "resolved", resolution: resolution.data };
}

/**
 * Expires a still-PENDING waitpoint and stops its run, keeping the
 * assistant message's content (the plan) and marking it CANCELLED with a
 * user-safe "how to continue" reason. All-or-nothing; a waitpoint that was
 * already decided/cancelled is left alone. Shared by the worker (token
 * timeout) and the recovery sweep.
 */
export async function expireWaitpoint(waitpointId: string): Promise<boolean> {
  try {
    await prisma.$transaction(async (tx) => {
      const wp = await tx.waitpoint.updateMany({
        where: { id: waitpointId, status: "PENDING" },
        data: { status: "EXPIRED" },
      });
      if (wp.count === 0) throw new SkippedTransition();
      const { agentRunId } = await tx.waitpoint.findUniqueOrThrow({ where: { id: waitpointId } });
      const run = await tx.agentRun.updateMany({
        where: { id: agentRunId, status: { in: ACTIVE_RUN_STATUSES } },
        data: {
          status: "CANCELLED",
          waitingReason: null,
          errorCode: WAITPOINT_EXPIRED_CODE,
          errorMessage: WAITPOINT_EXPIRED_MESSAGE,
          completedAt: new Date(),
        },
      });
      if (run.count > 0) {
        await tx.message.updateMany({
          where: { agentRunId, role: "ASSISTANT", status: "PENDING" },
          data: { status: "CANCELLED" },
        });
      }
    }, RUN_TRANSITION_TRANSACTION_OPTIONS);
    return true;
  } catch (error) {
    if (error instanceof SkippedTransition) return false;
    throw error;
  }
}

/**
 * Completes a RESOLVED waitpoint's token exactly once: a token that is no
 * longer WAITING is never completed again. A concurrent duplicate that
 * loses the race to complete is fine if the token is now COMPLETED.
 */
export async function ensureTokenCompleted(
  row: Pick<Waitpoint, "id" | "token" | "resolution">,
  client: WaitpointTokenClient,
): Promise<"completed" | "already_completed" | "timed_out"> {
  const status = await client.status(row.token);
  if (status === "COMPLETED") return "already_completed";
  if (status === "TIMED_OUT") return "timed_out";
  try {
    await client.complete(row.token, row.resolution);
    return "completed";
  } catch (error) {
    if ((await client.status(row.token).catch(() => null)) === "COMPLETED") return "already_completed";
    throw error;
  }
}

async function requireChatRun(userId: string, chatId: string, agentRunId: string): Promise<void> {
  await requireChatOwnership(userId, chatId);
  const run = await requireAgentRunOwnership(userId, agentRunId);
  if (run.chatId !== chatId) throw new NotFoundError("Agent run not found");
}

export async function listRunWaitpoints(
  userId: string,
  chatId: string,
  agentRunId: string,
): Promise<WaitpointListResponse> {
  await requireChatRun(userId, chatId, agentRunId);
  const rows = await prisma.waitpoint.findMany({
    where: { agentRunId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 20,
  });
  return { items: rows.map(toWaitpointResponse) };
}

/**
 * POST .../waitpoints/{id}/resolve. The first decision wins and is
 * returned to every duplicate; each request (re)ensures the token is
 * completed, so a repeat after a failed completion resumes the run.
 */
/** Trigger.dev's status for a run id (injected in tests). */
export type ExecutionStatusReader = (triggerRunId: string) => Promise<string>;

/**
 * Before a decision is applied, confirms the run's Trigger.dev execution can
 * still accept it. Confirmed finished → the run is interrupted at once (not
 * left for the stale-run sweep) and the request fails with 409. Unknown or
 * unreadable → nothing changes, retryable 503: an execution is never
 * presumed dead.
 */
async function assertExecutionAcceptsDecision(
  run: { id: string; triggerRunId: string | null },
  readStatus: ExecutionStatusReader,
  log: Record<string, unknown>,
): Promise<void> {
  let status: string;
  try {
    if (!run.triggerRunId) throw new Error("No Trigger.dev run recorded for this AgentRun");
    status = await readStatus(run.triggerRunId);
  } catch (error) {
    console.error("Waitpoint resolve: execution status unavailable", {
      ...log,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new ExecutionStatusUnavailableError();
  }
  if (LIVE_TRIGGER_RUN_STATUSES.has(status)) return;
  if (FINISHED_TRIGGER_RUN_STATUSES.has(status)) {
    // Guarded: concurrent requests (or the sweep) make exactly one transition.
    const interrupted = await interruptRun(run.id);
    console.warn("Waitpoint resolve: execution already finished; run interrupted", { ...log, status, interrupted });
    throw new RunInterruptedError();
  }
  console.error("Waitpoint resolve: unrecognised execution status", { ...log, status });
  throw new ExecutionStatusUnavailableError();
}

/**
 * POST .../waitpoints/{id}/resolve. The first decision wins and is
 * returned to every duplicate; each request (re)ensures the token is
 * completed, so a repeat after a failed completion resumes the run. A
 * decision is only accepted while the run's execution is confirmed live.
 */
export async function resolveWaitpoint(
  userId: string,
  chatId: string,
  agentRunId: string,
  waitpointId: string,
  body: unknown,
  client: WaitpointTokenClient = triggerWaitpointTokenClient,
  readStatus: ExecutionStatusReader = triggerRunStatus,
): Promise<WaitpointResponse> {
  await requireChatRun(userId, chatId, agentRunId);
  let row = await prisma.waitpoint.findFirst({ where: { id: waitpointId, agentRunId } });
  if (!row) throw new NotFoundError("Waitpoint not found");
  const definition = waitpointDefinition(row.type);
  if (!definition) throw new ValidationError(`Waitpoints of type ${row.type} cannot be resolved`);
  const parsed = definition.resolutionSchema.safeParse(body);
  if (!parsed.success) throw new ValidationError("Invalid decision", parsed.error.issues);

  const run = await prisma.agentRun.findUniqueOrThrow({
    where: { id: agentRunId },
    select: { id: true, status: true, triggerRunId: true },
  });
  const log = { agentRunId, chatId, waitpointId: row.id, waitpointTokenId: row.token, triggerRunId: run.triggerRunId };

  if (row.status === "PENDING") {
    // A run that already ended (e.g. crashed while waiting) can't resume.
    if (!ACTIVE_RUN_STATUSES.includes(run.status)) {
      await prisma.waitpoint.updateMany({ where: { id: row.id, status: "PENDING" }, data: { status: "CANCELLED" } });
      throw new ConflictError("This run has already ended. Send a new message to continue.");
    }
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
      throw new ConflictError(WAITPOINT_EXPIRED_MESSAGE);
    }
    await assertExecutionAcceptsDecision(run, readStatus, log);
    await prisma.waitpoint.updateMany({
      where: { id: row.id, status: "PENDING" },
      data: { status: "RESOLVED", resolution: parsed.data as Prisma.InputJsonValue, resolvedAt: new Date() },
    });
    row = await prisma.waitpoint.findUniqueOrThrow({ where: { id: row.id } });
  } else if (row.status === "RESOLVED" && run.status === "WAITING") {
    // A repeat after a failed token completion: only redeliver to a live execution.
    await assertExecutionAcceptsDecision(run, readStatus, log);
  }
  if (row.status === "EXPIRED") throw new ConflictError(WAITPOINT_EXPIRED_MESSAGE);
  if (row.status === "CANCELLED") throw new ConflictError("This run was stopped, so the decision is no longer needed.");

  try {
    const outcome = await ensureTokenCompleted(row, client);
    console.info("Waitpoint resolved", { ...log, outcome });
  } catch (error) {
    console.error("Waitpoint token completion failed; decision saved, retry resumes", {
      ...log,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new WaitpointResumeError();
  }
  return toWaitpointResponse(row);
}
