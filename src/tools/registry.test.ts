import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createToolRegistry, toOpenRouterTools, PRODUCTION_TOOL_REGISTRY } from "./registry";
import type { ToolDefinition } from "./types";

function makeTool(name: string): ToolDefinition<{ x: string }, { y: string }> {
  return {
    name,
    description: `does ${name}`,
    inputSchema: z.object({ x: z.string() }),
    outputSchema: z.object({ y: z.string() }),
    async execute(input) {
      return { y: input.x };
    },
  };
}

describe("PRODUCTION_TOOL_REGISTRY", () => {
  it("is empty — no tool is exposed to a real conversation in Phase 2 (Decision A)", () => {
    expect(PRODUCTION_TOOL_REGISTRY.size).toBe(0);
  });
});

describe("createToolRegistry", () => {
  it("builds a lookup map keyed by tool name", () => {
    const registry = createToolRegistry([makeTool("a"), makeTool("b")]);
    expect(registry.size).toBe(2);
    expect(registry.get("a")?.name).toBe("a");
    expect(registry.get("missing")).toBeUndefined();
  });

  it("rejects a duplicate tool name rather than silently overwriting it", () => {
    expect(() => createToolRegistry([makeTool("a"), makeTool("a")])).toThrow(/Duplicate/);
  });

  it("defaults to an empty registry", () => {
    expect(createToolRegistry().size).toBe(0);
  });
});

describe("toOpenRouterTools", () => {
  it("converts a tool's own Zod inputSchema into OpenRouter's tools request shape — one source of truth, nothing hand-duplicated", () => {
    const registry = createToolRegistry([makeTool("a")]);
    const specs = toOpenRouterTools(registry);
    expect(specs).toEqual([
      {
        type: "function",
        function: {
          name: "a",
          description: "does a",
          parameters: {
            type: "object",
            properties: { x: { type: "string" } },
            required: ["x"],
            additionalProperties: false,
          },
        },
      },
    ]);
  });

  it("strips $schema — a meta-key about the schema document, not a property OpenRouter expects inside parameters", () => {
    const [spec] = toOpenRouterTools(createToolRegistry([makeTool("a")]));
    expect(spec.function.parameters).not.toHaveProperty("$schema");
  });

  it("returns an empty array for an empty registry", () => {
    expect(toOpenRouterTools(createToolRegistry())).toEqual([]);
  });
});
