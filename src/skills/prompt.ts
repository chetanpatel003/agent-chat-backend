import type { SkillMetadata } from "./types";

/**
 * Builds the system-prompt fragment advertising available skills — name
 * and description only, never a skill's body (that would defeat the
 * point of loading it on demand). Pure and deterministic so it's
 * testable without a real OpenRouter call.
 */
export function buildSkillSystemPrompt(skills: SkillMetadata[]): string {
  if (skills.length === 0) {
    return "You have no optional skills available right now.";
  }

  const list = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");

  return [
    "You have access to the following optional skills. Each one provides",
    "specialized guidance for a particular kind of task. Skills are not",
    "loaded automatically: call the `load_skill` tool with a skill's exact",
    "name only when its guidance is actually relevant to what the user is",
    "asking right now, then follow its instructions for the rest of this",
    "conversation. Do not load a skill that isn't relevant, and do not",
    "load every skill just because it exists.",
    "",
    "Available skills:",
    list,
    "",
    "If a loaded skill's own instructions reference a supporting guide or",
    "asset by a relative path, use the `read_skill_asset` tool with that",
    "skill's name and the relative path to read it. A skill's supporting",
    "assets can only be read after that skill has been loaded with",
    "`load_skill`.",
  ].join("\n");
}
