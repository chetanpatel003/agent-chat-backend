import { z } from "zod";
import type { AnyToolDefinition, ToolRegistry } from "./types";
import { loadSkillTool, readSkillAssetTool } from "./skills";
import { generateImageTool } from "./magica-tools";

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
 * conversation until Phase 3's Magica tools. Checkpoint 2.5 amended
 * that narrowly with the two local-only skill tools. Checkpoint 3.3
 * registers the first real, credit-consuming Magica tool,
 * `generate_image` -- live-verified (project-docs/magica/
 * LIVE_VERIFICATION.md), staged deliberately ahead of
 * `edit_image`/`crop_image`/`merge_videos`, which are not yet built
 * (per this checkpoint's own "prove the path first" instruction).
 * executeAgentTurn() defaults to this; tests substitute their own
 * registry via its `registry` parameter and never mutate this one.
 */
export const PRODUCTION_TOOL_REGISTRY: ToolRegistry = createToolRegistry([
  loadSkillTool,
  readSkillAssetTool,
  generateImageTool,
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
