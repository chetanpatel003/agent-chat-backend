import type { ZodType } from "zod";

export type ToolExecutionContext = {
  agentRunId: string;
  userId: string;
};

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
   * Phase 3): called instead of `execute()` when re-entry finds this
   * invocation still RUNNING, so a crash/restart polls the provider's
   * own run rather than blindly starting a second one. A tool with no
   * real external run (the fixture tool, Phase 2) doesn't define this —
   * see run-agent-turn.ts for the safe default when it's absent.
   */
  reconcile?: (invocation: {
    id: string;
    providerRunId: string | null;
  }) => Promise<TOutput | null>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a registry necessarily holds tools of different input/output shapes; each entry's own generics stay precise where it's looked up and used
export type AnyToolDefinition = ToolDefinition<any, any>;

export type ToolRegistry = ReadonlyMap<string, AnyToolDefinition>;
