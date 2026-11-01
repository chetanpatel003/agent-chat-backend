import { z } from "zod";
import type { ToolDefinition } from "@/tools/types";
import { startMagicaRun } from "@/providers/magica";
import { persistProviderRunId, pollMagicaRunToCompletion, reconcileMagicaRun, durableWait, type DurableWait } from "@/services/magica-run";

/**
 * A single, concrete Magica-backed tool, used only to exercise the
 * real start → persist → poll → reconcile machinery
 * (src/providers/magica.ts, src/services/magica-run.ts) through the
 * real `executeAgentTurn`/`runOneToolCall` loop in tests. Deliberately
 * never registered into `PRODUCTION_TOOL_REGISTRY` — checkpoint 3.2's
 * own scope explicitly excludes registering Crop Image/GPT Image
 * 2/Merge Videos. Lives in `src/test-utils` (not `src/tools`), same
 * convention as `fixture-tool.ts`, so it reads as test infrastructure.
 *
 * A factory, not a bare export, so tests can inject a fast no-op
 * `waitFn` instead of the real `wait.for()` — which throws outside a
 * live Trigger.dev task context (confirmed by reading the installed
 * SDK, see `magica-run.ts`'s own doc comment) — exactly the
 * dependency-injection pattern already used for the tool registry,
 * the realtime publisher, and the skill registry.
 */
const MAGICA_FIXTURE_NODE_TYPE = "magica_test_node";

const MagicaFixtureInputSchema = z.object({ prompt: z.string().min(1) });
const MagicaFixtureOutputSchema = z.object({ result: z.unknown() });

export const MAGICA_FIXTURE_TOOL_NAME = "magica_test_tool";

export function createMagicaFixtureTool(
  waitFn: DurableWait = durableWait,
): ToolDefinition<z.infer<typeof MagicaFixtureInputSchema>, z.infer<typeof MagicaFixtureOutputSchema>> {
  return {
    name: MAGICA_FIXTURE_TOOL_NAME,
    description: "Test-only Magica-backed tool exercising the real start/persist/poll/reconcile machinery.",
    inputSchema: MagicaFixtureInputSchema,
    outputSchema: MagicaFixtureOutputSchema,
    async execute(input, context) {
      const started = await startMagicaRun(MAGICA_FIXTURE_NODE_TYPE, input);

      // Persisted immediately after the 202, before any poll/wait — per
      // this checkpoint's own requirement. A failure to apply this
      // write means Magica may have already started a billable run we
      // can no longer track; never attempt a second start because of
      // it.
      const persisted = await persistProviderRunId(context.invocationId, started.runId);
      if (!persisted.applied) {
        throw new Error(
          `Magica run ${started.runId} started but could not be durably recorded against invocation ${context.invocationId}`,
        );
      }

      const outcome = await pollMagicaRunToCompletion({
        agentRunId: context.agentRunId,
        providerRunId: started.runId,
        waitFn,
      });
      if (outcome.status === "failed") {
        throw new Error(outcome.errorMessage);
      }
      return { result: outcome.output };
    },
    async reconcile(invocation) {
      const outcome = await reconcileMagicaRun(invocation, waitFn);
      if (outcome.status === "completed") {
        // Wrapped the same way execute() wraps it (`{ result: ... }`) —
        // a tool's persisted output must be shaped the same regardless
        // of which path produced it.
        return { status: "completed" as const, output: { result: outcome.output } };
      }
      return outcome;
    },
  };
}
