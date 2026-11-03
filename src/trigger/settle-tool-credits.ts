import { task } from "@trigger.dev/sdk";
import { z } from "zod";
import { settleToolInvocationCredits, type SettlementResult } from "@/services/credit-settlement";

// Durable, idempotent settlement of one terminal billable ToolInvocation.
// Independent of the parent AgentRun (no liveness gate; works after the run
// is terminal). Reads only persisted state; never calls Magica. A thrown
// error (e.g. DB unavailable) is retried with bounded backoff; every
// definitive result (settled / already settled / nothing to settle) returns.

const SettleToolCreditsPayloadSchema = z.object({ toolInvocationId: z.uuid() });
export type SettleToolCreditsPayload = z.infer<typeof SettleToolCreditsPayloadSchema>;

export const SETTLEMENT_RETRY = {
  maxAttempts: 5,
  factor: 2,
  minTimeoutInMs: 2_000,
  maxTimeoutInMs: 60_000,
  randomize: true,
} as const;

export async function runToolCreditSettlement(payload: unknown): Promise<SettlementResult> {
  const { toolInvocationId } = SettleToolCreditsPayloadSchema.parse(payload);
  return settleToolInvocationCredits(toolInvocationId);
}

export const settleToolCredits = task({
  id: "settle-tool-credits",
  retry: SETTLEMENT_RETRY,
  run: (payload: SettleToolCreditsPayload) => runToolCreditSettlement(payload),
});

export function settlementTaskIdempotencyKey(toolInvocationId: string): string {
  return `settle-tool-credits:${toolInvocationId}`;
}

/** Never throws. Dispatch failure is logged; the inline attempt and run recovery remain.
 * `idempotencyKey` defaults to the per-invocation key; the recovery sweep passes a
 * sweep-window key so a job whose earlier attempts were exhausted can run again
 * (settlement itself stays exactly-once via its own guards). */
export async function dispatchCreditSettlement(
  toolInvocationId: string,
  idempotencyKey: string = settlementTaskIdempotencyKey(toolInvocationId),
): Promise<boolean> {
  try {
    await settleToolCredits.trigger({ toolInvocationId }, { idempotencyKey, idempotencyKeyTTL: "24h" });
    return true;
  } catch (error) {
    console.error("Credit settlement dispatch failed", {
      toolInvocationId,
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return false;
  }
}
