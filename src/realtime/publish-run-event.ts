import { metadata } from "@trigger.dev/sdk";
import { RunEventSchema, type RunEvent, type DistributiveOmit } from "@/contracts/run-event";

export type PublishRunEvent = (event: RunEvent) => Promise<void> | void;

/**
 * Publishes one run event via Trigger.dev's own Realtime mechanism —
 * `metadata.append("events", event)` against the *current* task run.
 * This is Decision B's entire publishing interface: not a new event bus,
 * just this one function. Verified against the installed SDK's own
 * declarations (dist/esm/v3/metadata.d.ts) — `metadata.append(key,
 * value)` appends to an array under `key` in the current run's
 * metadata; it only does anything meaningful inside a live task
 * execution context.
 *
 * Never throws. A realtime publish is explicitly non-authoritative
 * (Postgres is; the client reconciles via REST) — failing to validate or
 * failing to publish must never interrupt or fail the AgentRun that
 * triggered it, so both failure modes are caught and logged here
 * instead of propagated. Callers (run-agent-turn.ts) wrap even the
 * *injected* publisher used in tests in the same way, since a test
 * double bypasses this function entirely.
 */
export const publishRunEvent: PublishRunEvent = (event) => {
  const parsed = RunEventSchema.safeParse(event);
  if (!parsed.success) {
    console.error("publishRunEvent: event failed validation, not published", {
      runId: (event as { runId?: unknown }).runId,
      type: (event as { type?: unknown }).type,
      error: parsed.error.message,
    });
    return;
  }
  try {
    metadata.append("events", parsed.data);
  } catch (error) {
    console.error("publishRunEvent: metadata.append failed", {
      runId: parsed.data.runId,
      type: parsed.data.type,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

export type EmitRunEvent = (
  event: DistributiveOmit<RunEvent, "runId" | "seq" | "at">,
) => Promise<void>;

/**
 * Fills in `runId`/`seq`/`at` for every event in one execution, so call
 * sites only ever supply what's actually event-specific, and `seq` is
 * guaranteed monotonically increasing without every call site tracking
 * its own counter. Also the one place that isolates the *injected*
 * publisher (which may be a real publisher, a spy, or a deliberately
 * failing test double) from the worker loop — nothing it does can
 * escape as an exception.
 */
export function createRunEventEmitter(runId: string, publish: PublishRunEvent): EmitRunEvent {
  let seq = 0;
  return async (event) => {
    seq += 1;
    const full = { ...event, runId, seq, at: new Date().toISOString() } as RunEvent;
    try {
      await publish(full);
    } catch (error) {
      console.error("Realtime publish failed", {
        runId,
        type: full.type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
