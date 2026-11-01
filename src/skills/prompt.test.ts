import { describe, it, expect } from "vitest";
import { buildSkillSystemPrompt } from "./prompt";

describe("buildSkillSystemPrompt", () => {
  it("lists every skill's name and description, but never its instructions body", () => {
    const prompt = buildSkillSystemPrompt([
      { name: "image-editing", description: "Guidance for planning image edits." },
      { name: "video-editing", description: "Guidance for planning video merges." },
    ]);
    expect(prompt).toContain("image-editing: Guidance for planning image edits.");
    expect(prompt).toContain("video-editing: Guidance for planning video merges.");
    expect(prompt).toContain("load_skill");
    expect(prompt).toContain("read_skill_asset");
  });

  it("does not include a skill's full instructions — metadata only", () => {
    const prompt = buildSkillSystemPrompt([
      { name: "image-editing", description: "Guidance for planning image edits." },
    ]);
    // The real SKILL.md body contains this exact sentence fragment; it
    // must never leak into the base prompt before load_skill is called.
    expect(prompt).not.toContain("Preserve the subject");
  });

  it("handles an empty skill list without crashing", () => {
    expect(() => buildSkillSystemPrompt([])).not.toThrow();
    expect(buildSkillSystemPrompt([])).toMatch(/no optional skills/i);
  });
});
