import { z } from "zod";
import type { ToolDefinition } from "@/tools/types";

/**
 * Deterministic, test-only tool. Never registered into
 * PRODUCTION_TOOL_REGISTRY and never exposed to a real conversation —
 * lives in src/test-utils (not src/tools) by convention, mirroring
 * db-fixtures.ts, so it's structurally obvious it's test infrastructure,
 * importable only by test files.
 */
const FixtureToolInputSchema = z.object({
  timezone: z.string().min(1).max(64).optional(),
  // Test-only escape hatch: lets a test deterministically force the
  // execute()-throws path without needing a tool that can genuinely
  // fail. Never a real product field.
  simulateFailure: z.boolean().optional(),
});

const FixtureToolOutputSchema = z.object({
  isoTime: z.string(),
  timezone: z.string(),
});

type FixtureToolInput = z.infer<typeof FixtureToolInputSchema>;
type FixtureToolOutput = z.infer<typeof FixtureToolOutputSchema>;

export const FIXTURE_TOOL_NAME = "get_current_time";

export const fixtureTool: ToolDefinition<FixtureToolInput, FixtureToolOutput> = {
  name: FIXTURE_TOOL_NAME,
  description: "Returns the current time. Test fixture only — never registered in production.",
  inputSchema: FixtureToolInputSchema,
  outputSchema: FixtureToolOutputSchema,
  async execute(input) {
    if (input.simulateFailure) {
      throw new Error("Simulated fixture tool failure");
    }
    return {
      isoTime: new Date().toISOString(),
      timezone: input.timezone ?? "UTC",
    };
  },
};

/**
 * A second fixture tool, identical except for a `reconcile` handler —
 * exists only to exercise the re-entry dispatch-to-reconcile path
 * (project-docs/PHASE2-PLAN.md: "signature-level test only, not a full
 * dormant-path test suite," since nothing in Phase 2 has a real async
 * tool to safely resume a loop against). Simulates a Magica-style
 * external run that actually completed, confirmed by polling, despite
 * our own row never being updated before a crash.
 */
export const fixtureToolWithReconcile: ToolDefinition<FixtureToolInput, FixtureToolOutput> = {
  ...fixtureTool,
  name: "get_current_time_reconcilable",
  async reconcile() {
    return { isoTime: "2026-01-01T00:00:00.000Z", timezone: "UTC" };
  },
};
