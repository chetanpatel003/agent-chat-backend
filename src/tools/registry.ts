import { z } from "zod";
import type { AnyToolDefinition, ToolRegistry } from "./types";
import { loadSkillTool, readSkillAssetTool } from "./skills";

export function createToolRegistry(tools: AnyToolDefinition[] = []): ToolRegistry {
  const map = new Map<string, AnyToolDefinition>();
  for (const tool of tools) {
    if (map.has(tool.name)) {
      throw new Error(`Duplicate tool name in registry: "${tool.name}"`);
    }
    map.set(tool.name, tool);
  }
  return map;
}

/**
 * The production registry. Decision A (project-docs/PHASE2-PLAN.md)
 * kept this empty through checkpoint 2.4 -- no tool exposed to a real
 * conversation until Phase 3's Magica tools. Checkpoint 2.5 amends that
 * narrowly and explicitly: the two skill-loading tools are real,
 * low-risk, local-only capabilities (no external provider call, no
 * credit charge, no business side effect) and this checkpoint's own
 * instructions require registering them here. Magica/business tools
 * remain out until Phase 3 -- this is not a general reopening of
 * Decision A. executeAgentTurn() defaults to this; tests substitute their
 * own registry via its `registry` parameter and never mutate this one.
 */
export const PRODUCTION_TOOL_REGISTRY: ToolRegistry = createToolRegistry([
  loadSkillTool,
  readSkillAssetTool,
]);

export type OpenRouterToolSpec = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

/**
 * Converts a registry into OpenRouter's `tools` request field. Each
 * tool's own Zod `inputSchema` is the single source of truth for its
 * JSON Schema (via Zod 4's built-in `z.toJSONSchema`) — nothing is
 * hand-duplicated. `$schema` is stripped: it describes the schema
 * document itself, not a property OpenRouter expects inside `parameters`.
 */
export function toOpenRouterTools(registry: ToolRegistry): OpenRouterToolSpec[] {
  return Array.from(registry.values()).map((tool) => {
    const parameters = z.toJSONSchema(tool.inputSchema) as Record<string, unknown>;
    delete parameters.$schema;
    return {
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters,
      },
    };
  });
}
