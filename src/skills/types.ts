/**
 * What the model (and the base prompt) is allowed to see about a skill
 * before it's loaded: name and description only, never its body.
 */
export type SkillMetadata = {
  name: string;
  description: string;
};

/** One supporting file discovered inside a skill's own directory,
 * already vetted (approved extension, bounded size, realpath-contained)
 * at discovery time. `relativePath` is always posix-style, relative to
 * the skill's own directory — never absolute, never exposed with the
 * skill's real filesystem location. */
export type SkillAsset = {
  relativePath: string;
  absolutePath: string;
};

export type SkillEntry = {
  name: string;
  description: string;
  /** Resolved (realpath'd) absolute directory — internal only, never
   * serialized into a tool output or the model prompt. */
  dir: string;
  /** SKILL.md's body, frontmatter stripped, trimmed. */
  instructions: string;
  /** sha256 of `instructions`, the version identity persisted per-run. */
  contentHash: string;
  /** Approved relative-path -> asset lookup; read_skill_asset resolves
   * through this map, never through a raw path.resolve() on the
   * caller's input. */
  assets: ReadonlyMap<string, SkillAsset>;
};

export type SkillRegistry = ReadonlyMap<string, SkillEntry>;
