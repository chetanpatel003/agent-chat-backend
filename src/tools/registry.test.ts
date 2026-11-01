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
  // Decision A kept this empty through checkpoint 2.4. Checkpoint 2.5
  // amended it with the two local-only skill tools. Checkpoint 3.3
  // adds the first real, credit-consuming Magica tool, generate_image
  // — live-verified, staged deliberately ahead of
  // edit_image/crop_image/merge_videos (not yet built) — see
  // src/tools/skills.test.ts and src/tools/magica-tools.test.ts for
  // each tool's own behavior.
  it("contains exactly the skill tools plus generate_image — nothing else yet", () => {
    expect(PRODUCTION_TOOL_REGISTRY.size).toBe(3);
    expect([...PRODUCTION_TOOL_REGISTRY.keys()].sort()).toEqual(["generate_image", "load_skill", "read_skill_asset"]);
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
