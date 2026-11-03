import type { ToolProgressPhase } from "@/contracts/run-event";
import type { ZodType } from "zod";

export type ToolExecutionContext = {
  agentRunId: string;
  userId: string;
  /** The id of the ToolInvocation row already persisted for this exact
   * call (created RUNNING before `execute()` is ever called — see
   * run-agent-turn.ts#runOneToolCall). Required, not optional: a
   * provider-backed tool (Magica, checkpoint 3.2) must persist its
   * remote run id against *this specific row*, and `agentRunId` alone
   * cannot disambiguate when more than one tool call exists under the
   * same run. */
  invocationId: string;
  /** Best-effort progress report for the UI (e.g. the provider accepted
   * the job). Never throws; a tool must not depend on it. */
  onProgress?: (phase: ToolProgressPhase) => Promise<void>;
};

/** The two outcomes `reconcile()` can resolve to. A third state —
 * "still inconclusive, leave the invocation RUNNING" — is deliberately
 * not a return variant here; it's signaled by *throwing* instead (see
 * `MagicaPollInconclusiveError` in src/providers/magica.ts and its
 * handling in run-agent-turn.ts), so `execute()` and `reconcile()`
 * share one signaling convention rather than two. */
export type ToolReconcileOutcome<TOutput> =
  | { status: "completed"; output: TOutput }
  | { status: "failed"; errorCode: string; errorMessage: string; creditUsed?: number };

/** A tool failure carrying a specific, user-safe error code; any other
 * thrown error is recorded as EXECUTION_FAILED, as before. */
export class ToolExecutionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolExecutionError";
  }
}

/** A provider run that ended FAILED/CANCELED. Same message and error
 * semantics as a plain failure; additionally carries the provider's
 * reported raw `creditUsed` so it can be persisted and settled. */
export class ProviderRunFailedError extends Error {
  constructor(
    message: string,
    public readonly creditUsed: number | undefined,
  ) {
    super(message);
    this.name = "ProviderRunFailedError";
  }
}

/**
 * One entry in the authoritative tool registry. `inputSchema`/
 * `outputSchema` are the single source of truth for both validation and
 * the JSON Schema sent to OpenRouter (via `z.toJSONSchema`) — adding a
 * tool never means duplicating its shape in two places.
 */
export type ToolDefinition<TInput = unknown, TOutput = unknown> = {
  name: string;
  description: string;
  inputSchema: ZodType<TInput>;
  outputSchema: ZodType<TOutput>;
  execute: (input: TInput, context: ToolExecutionContext) => Promise<TOutput>;
  /**
   * For a tool backed by a long-running external provider run (Magica,
   * checkpoint 3.2): called instead of `execute()` when re-entry finds
   * this invocation still RUNNING, so a crash/restart polls the
   * provider's own run rather than blindly starting a second one. A
   * tool with no real external run (the fixture tool) doesn't define
   * this — see run-agent-turn.ts for the safe default when it's
   * absent. Throws `MagicaPollInconclusiveError` (or any error) to mean
   * "still can't tell, leave the invocation RUNNING" — the caller
   * treats every throw this way, never as a crash.
   */
  reconcile?: (
    invocation: { id: string; providerRunId: string | null },
    /** singlePoll: one provider status read, independent of the AgentRun (recovery sweep). */
    options?: { singlePoll?: boolean },
  ) => Promise<ToolReconcileOutcome<TOutput>>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a registry necessarily holds tools of different input/output shapes; each entry's own generics stay precise where it's looked up and used
export type AnyToolDefinition = ToolDefinition<any, any>;

export type ToolRegistry = ReadonlyMap<string, AnyToolDefinition>;
