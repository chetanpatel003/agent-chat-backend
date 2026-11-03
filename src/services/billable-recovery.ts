import { prisma } from "@/lib/prisma";
import { MagicaPollInconclusiveError } from "@/providers/magica";
import { BILLABLE_TOOL_NAMES } from "@/services/credit-settlement";
import { persistReconciledOutcome } from "@/services/tool-reconciliation";
import { PRODUCTION_TOOL_REGISTRY } from "@/tools/registry";
import { PROVIDER_OUTCOME_UNKNOWN, type ToolRegistry } from "@/tools/types";

// Bounded recovery sweep for billable (Magica) tool invocations, run on a
// schedule. Never starts a provider run: stale RUNNING invocations are
// resolved only through the tool's existing reconcile() with a single
// status read of the persisted providerRunId.

/** An invocation (and its AgentRun) untouched this long has no live poller:
 * the in-turn polling budget is 5 minutes (MAGICA_POLL_MAX_ELAPSED_MS). */
export const STALE_RUNNING_THRESHOLD_MS = 15 * 60_000;
/** Terminal invocations get this long for the inline/durable settlement first. */
export const SETTLEMENT_GRACE_MS = 5 * 60_000;
/** Per category, per sweep. */
export const RECOVERY_BATCH_SIZE = 25;
export const RECOVERY_SWEEP_INTERVAL_MS = 10 * 60_000;
/** Application credits went live with checkpoint 5.1; provider usage before
 * this predates the ledger and is never charged retroactively. */
export const SETTLEMENT_EPOCH = new Date("2026-11-02T12:00:00.000Z");

export type RecoveryDeps = {
  registry: ToolRegistry;
  dispatchSettlement: (toolInvocationId: string, idempotencyKey: string) => Promise<boolean>;
  dispatchArchival: (toolInvocationId: string) => Promise<unknown>;
};

export type RecoverySummary = {
  staleChecked: number;
  reconciled: number;
  stillRunning: number;
  reconcileFailed: number;
  settlementDispatched: number;
  settlementDispatchFailed: number;
  /** L1: RUNNING invocations with no provider run id, whose run has ended, closed as outcome-unknown. */
  orphansClosed: number;
};

/** What an orphan is closed with: the provider may or may not have run; nothing is invented or charged. */
export const ORPHAN_OUTCOME = {
  status: "failed" as const,
  errorCode: PROVIDER_OUTCOME_UNKNOWN,
  errorMessage:
    "This request was interrupted before its provider run could be recorded, so its outcome is unknown. It was not charged; ask again if you still need it.",
};

/** One key per invocation per sweep window: concurrent sweeps dedupe, a later
 * window can retry a job whose attempts were exhausted. */
export function sweepSettlementKey(toolInvocationId: string, now: Date): string {
  return `settle-tool-credits:${toolInvocationId}:sweep:${Math.floor(now.getTime() / RECOVERY_SWEEP_INTERVAL_MS)}`;
}

export async function sweepBillableInvocations(deps: RecoveryDeps, now = new Date()): Promise<RecoverySummary> {
  const summary: RecoverySummary = {
    staleChecked: 0,
    reconciled: 0,
    stillRunning: 0,
    reconcileFailed: 0,
    settlementDispatched: 0,
    settlementDispatchFailed: 0,
    orphansClosed: 0,
  };
  const dispatch = async (id: string) => {
    const ok = await deps.dispatchSettlement(id, sweepSettlementKey(id, now));
    if (ok) summary.settlementDispatched++;
    else summary.settlementDispatchFailed++; // logged by the dispatcher; the next sweep retries
  };

  // 1. Stale RUNNING invocations with a persisted provider run.
  const staleBefore = new Date(now.getTime() - STALE_RUNNING_THRESHOLD_MS);
  const stale = await prisma.toolInvocation.findMany({
    where: {
      status: "RUNNING",
      toolName: { in: [...BILLABLE_TOOL_NAMES] },
      providerRunId: { not: null },
      updatedAt: { lt: staleBefore },
      agentRun: { updatedAt: { lt: staleBefore } },
    },
    orderBy: { updatedAt: "asc" },
    take: RECOVERY_BATCH_SIZE,
    select: { id: true, toolName: true, providerRunId: true },
  });
  for (const invocation of stale) {
    summary.staleChecked++;
    const tool = deps.registry.get(invocation.toolName);
    if (!tool?.reconcile) continue;
    let outcome;
    try {
      outcome = await tool.reconcile({ id: invocation.id, providerRunId: invocation.providerRunId }, { singlePoll: true });
    } catch (error) {
      if (error instanceof MagicaPollInconclusiveError) summary.stillRunning++;
      else {
        summary.reconcileFailed++;
        console.error("Billable recovery: reconcile failed", {
          toolInvocationId: invocation.id,
          error: error instanceof Error ? error.name : "UnknownError",
        });
      }
      continue; // left RUNNING for a later sweep
    }
    if (await persistReconciledOutcome(invocation.id, outcome)) {
      summary.reconciled++;
      await dispatch(invocation.id);
      if (outcome.status === "completed") await deps.dispatchArchival(invocation.id);
    }
  }

  // 2. Terminal invocations with reported usage that were never settled.
  const unsettled = await prisma.toolInvocation.findMany({
    where: {
      status: { in: ["COMPLETED", "FAILED"] },
      creditsCharged: null,
      toolName: { in: [...BILLABLE_TOOL_NAMES] },
      createdAt: { gte: SETTLEMENT_EPOCH },
      updatedAt: { lt: new Date(now.getTime() - SETTLEMENT_GRACE_MS) },
      output: { path: ["creditUsed"], gte: 0 },
    },
    orderBy: { updatedAt: "asc" },
    take: RECOVERY_BATCH_SIZE,
    select: { id: true },
  });
  for (const { id } of unsettled) await dispatch(id);

  // 3. Orphans: RUNNING with no persisted provider run, untouched, and their run
  // has ended — nothing can ever reconcile them (there is no run id to ask
  // about, and a new run must never be started). Closed as outcome-unknown,
  // with no usage recorded, so settlement never charges them.
  const orphans = await prisma.toolInvocation.findMany({
    where: {
      status: "RUNNING",
      providerRunId: null,
      toolName: { in: [...BILLABLE_TOOL_NAMES] },
      updatedAt: { lt: staleBefore },
      agentRun: { status: { notIn: ["QUEUED", "RUNNING", "WAITING"] }, updatedAt: { lt: staleBefore } },
    },
    orderBy: { updatedAt: "asc" },
    take: RECOVERY_BATCH_SIZE,
    select: { id: true },
  });
  for (const { id } of orphans) {
    if (await persistReconciledOutcome(id, ORPHAN_OUTCOME)) summary.orphansClosed++;
  }

  return summary;
}

export const PRODUCTION_RECOVERY_REGISTRY: ToolRegistry = PRODUCTION_TOOL_REGISTRY;
