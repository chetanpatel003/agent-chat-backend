import { task } from "@trigger.dev/sdk";
import { z } from "zod";
import { archiveInvocationOutputs, type ArchivalSummary } from "@/services/generated-assets";

// Durable archival of a completed Magica invocation's outputs into B2,
// independent of the parent AgentRun (no liveness gate, no OpenRouter, no
// Magica): it only re-reads ToolInvocation.output and delegates to
// archiveInvocationOutputs(). Transient failures throw so Trigger.dev
// retries with bounded backoff; permanent ones return so they never loop.

const ArchiveGeneratedAssetsPayloadSchema = z.object({ toolInvocationId: z.uuid() });
export type ArchiveGeneratedAssetsPayload = z.infer<typeof ArchiveGeneratedAssetsPayloadSchema>;

/** Bounded: at most 5 attempts (~2s → 4s → 8s → 16s backoff, capped at 60s). */
export const ARCHIVAL_RETRY = {
  maxAttempts: 5,
  factor: 2,
  minTimeoutInMs: 2_000,
  maxTimeoutInMs: 60_000,
  randomize: true,
} as const;

/** Thrown to ask Trigger.dev for another (bounded) attempt. */
export class TransientArchivalError extends Error {
  constructor(public readonly summary: ArchivalSummary) {
    super(`Generated asset archival incomplete: ${summary.transientFailures} output(s) failed transiently`);
    this.name = "TransientArchivalError";
  }
}

export async function runGeneratedAssetArchival(payload: unknown): Promise<ArchivalSummary> {
  const { toolInvocationId } = ArchiveGeneratedAssetsPayloadSchema.parse(payload);
  const summary = await archiveInvocationOutputs(toolInvocationId);
  if (summary.transientFailures > 0) throw new TransientArchivalError(summary);
  return summary;
}

export const archiveGeneratedAssets = task({
  id: "archive-generated-assets",
  retry: ARCHIVAL_RETRY,
  // Large videos stream within the B2 module's own timeouts; this caps the whole attempt.
  maxDuration: 900,
  run: (payload: ArchiveGeneratedAssetsPayload) => runGeneratedAssetArchival(payload),
});

/** Deterministic per invocation: re-dispatching the same invocation is a no-op. */
export function archivalIdempotencyKey(toolInvocationId: string): string {
  return `archive-generated-assets:${toolInvocationId}`;
}

/**
 * Dispatches durable archival for a COMPLETED media invocation. Never
 * throws. If dispatch itself fails, the failure is logged and archival is
 * attempted inline once, so the job is never silently lost; any output
 * still not READY remains eligible for the run-level recovery sweep.
 */
export async function dispatchGeneratedAssetArchival(toolInvocationId: string): Promise<"dispatched" | "inline"> {
  try {
    await archiveGeneratedAssets.trigger(
      { toolInvocationId },
      { idempotencyKey: archivalIdempotencyKey(toolInvocationId), idempotencyKeyTTL: "24h" },
    );
    return "dispatched";
  } catch (error) {
    console.error("Generated asset archival dispatch failed; archiving inline", {
      toolInvocationId,
      error: error instanceof Error ? error.name : "UnknownError",
    });
    await archiveInvocationOutputs(toolInvocationId);
    return "inline";
  }
}
