import { describe, it, expect } from "vitest";
import { TOOL_DISPLAY, toolDisplay } from "./display";
import { ToolDisplaySchema } from "@/contracts/run-event";
import { generateImageTool, editImageTool, cropImageTool, mergeVideosTool } from "./magica-tools";
import { createLoadSkillTool, createReadSkillAssetTool } from "./skills";

const emptySkills = new Map() as never;

describe("tool display labels (one source for live status and history)", () => {
  const tools = [generateImageTool, editImageTool, cropImageTool, mergeVideosTool, createLoadSkillTool(emptySkills), createReadSkillAssetTool(emptySkills)];

  it("every production tool publishes its own, contract-valid display", () => {
    for (const tool of tools) {
      expect(tool.display, tool.name).toEqual(TOOL_DISPLAY[tool.name as keyof typeof TOOL_DISPLAY]);
      expect(ToolDisplaySchema.safeParse(tool.display).success, tool.name).toBe(true);
    }
  });

  it("each tool has a distinct, specific activity (no generic 'Waiting for image')", () => {
    const activities = tools.map((t) => t.display!.activity);
    expect(new Set(activities).size).toBe(activities.length);
    expect(activities).toContain("Merging videos with Magica");
    expect(activities.join(" ")).not.toMatch(/Waiting for/);
  });

  it("an unknown tool gets a neutral display derived from its name; an explicit one wins", () => {
    expect(toolDisplay("search_web")).toEqual({ name: "Search web", activity: "Running search web" });
    expect(toolDisplay("x", { name: "X", activity: "Doing x" })).toEqual({ name: "X", activity: "Doing x" });
  });
});
