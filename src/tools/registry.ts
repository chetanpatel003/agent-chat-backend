import { z } from "zod";
import type { AnyToolDefinition, ToolRegistry } from "./types";

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
 * The production registry. Empty by design, per Decision A in
 * project-docs/PHASE2-PLAN.md — no tool is exposed to a real conversation
 * until Phase 3 registers the real Magica tools into this exact
 * mechanism. executeAgentTurn() defaults to this; tests substitute their
 * own registry via its `registry` parameter and never mutate this one.
 */
export const PRODUCTION_TOOL_REGISTRY: ToolRegistry = createToolRegistry();

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
