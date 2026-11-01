import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import matter from "gray-matter";
import { z } from "zod";
import type { SkillAsset, SkillEntry, SkillMetadata, SkillRegistry } from "./types";
import { APPROVED_ASSET_EXTENSIONS, MAX_ASSET_FILE_BYTES, MAX_SKILL_FILE_BYTES } from "./paths";

const SKILL_NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

const SkillFrontmatterSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(64)
    .regex(SKILL_NAME_PATTERN, "must be lowercase kebab-case (e.g. \"image-editing\")"),
  description: z.string().trim().min(1).max(500),
});

/** Thrown by `discoverSkills` with every problem found across the whole
 * directory, not just the first — one actionable startup error instead
 * of a fix-one-rerun-find-the-next loop. */
export class SkillDiscoveryError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Skill discovery failed:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "SkillDiscoveryError";
  }
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/** Walks one skill's directory (depth-first, symlinks never followed
 * into a traversal — each candidate's realpath is checked against the
 * skill root before it's trusted) collecting approved supporting
 * assets. A file that fails any check (extension, size, containment) is
 * simply excluded from the approved set — it does not fail the whole
 * skill's registration, unlike a problem in SKILL.md itself. */
function discoverAssets(skillRealDir: string): Map<string, SkillAsset> {
  const assets = new Map<string, SkillAsset>();

  function walk(dir: string, relPrefix: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (relPrefix === "" && entry.name === "SKILL.md") continue;

      const candidatePath = path.join(dir, entry.name);
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;

      let real: string;
      try {
        real = fs.realpathSync(candidatePath);
      } catch {
        continue;
      }
      // Symlink escape protection: the resolved real path must still be
      // inside the skill's own real directory, checked here (not just a
      // string-prefix check on the unresolved candidate).
      if (real !== skillRealDir && !real.startsWith(skillRealDir + path.sep)) continue;

      let stat: fs.Stats;
      try {
        stat = fs.statSync(real);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(candidatePath, relPath);
        continue;
      }
      if (!stat.isFile()) continue;
      if (!APPROVED_ASSET_EXTENSIONS.includes(path.extname(real))) continue;
      if (stat.size === 0 || stat.size > MAX_ASSET_FILE_BYTES) continue;

      assets.set(relPath, { relativePath: relPath, absolutePath: real });
    }
  }

  walk(skillRealDir, "");
  return assets;
}

/**
 * Scans `rootDir` for skill bundles. Pure and parameterized (not tied to
 * the real `agent-skills/` directory) so tests can point it at a
 * throwaway fixture directory instead of needing to corrupt the real
 * one. Every problem across every bundle is collected before throwing
 * one aggregated `SkillDiscoveryError` — an invalid or duplicate bundle
 * is never silently skipped or silently registered.
 */
export function discoverSkills(rootDir: string): SkillEntry[] {
  if (!fs.existsSync(rootDir)) {
    throw new SkillDiscoveryError([`skills directory not found: ${rootDir}`]);
  }

  const dirEntries = fs
    .readdirSync(rootDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name));

  const problems: string[] = [];
  const byName = new Map<string, SkillEntry>();

  for (const dirent of dirEntries) {
    const skillDir = path.join(rootDir, dirent.name);
    let realDir: string;
    try {
      realDir = fs.realpathSync(skillDir);
    } catch {
      problems.push(`${dirent.name}: could not resolve directory`);
      continue;
    }

    const skillMdPath = path.join(realDir, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) {
      problems.push(`${dirent.name}: missing SKILL.md`);
      continue;
    }

    const stat = fs.statSync(skillMdPath);
    if (stat.size === 0) {
      problems.push(`${dirent.name}/SKILL.md: file is empty`);
      continue;
    }
    if (stat.size > MAX_SKILL_FILE_BYTES) {
      problems.push(`${dirent.name}/SKILL.md: exceeds ${MAX_SKILL_FILE_BYTES} bytes`);
      continue;
    }

    const raw = fs.readFileSync(skillMdPath, "utf8");
    let parsed: matter.GrayMatterFile<string>;
    try {
      parsed = matter(raw);
    } catch (error) {
      problems.push(
        `${dirent.name}/SKILL.md: malformed YAML frontmatter (${error instanceof Error ? error.message : String(error)})`,
      );
      continue;
    }

    if (!parsed.data || Object.keys(parsed.data).length === 0) {
      problems.push(`${dirent.name}/SKILL.md: missing frontmatter`);
      continue;
    }

    const frontmatter = SkillFrontmatterSchema.safeParse(parsed.data);
    if (!frontmatter.success) {
      const issues = frontmatter.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      problems.push(`${dirent.name}/SKILL.md: invalid frontmatter (${issues})`);
      continue;
    }

    const instructions = parsed.content.trim();
    if (instructions.length === 0) {
      problems.push(`${dirent.name}/SKILL.md: empty instructions body`);
      continue;
    }

    if (byName.has(frontmatter.data.name)) {
      problems.push(`duplicate skill name "${frontmatter.data.name}" (directory "${dirent.name}")`);
      continue;
    }

    byName.set(frontmatter.data.name, {
      name: frontmatter.data.name,
      description: frontmatter.data.description,
      dir: realDir,
      instructions,
      contentHash: sha256(instructions),
      assets: discoverAssets(realDir),
    });
  }

  if (problems.length > 0) {
    throw new SkillDiscoveryError(problems);
  }

  return [...byName.values()];
}

export function buildSkillRegistry(entries: SkillEntry[]): SkillRegistry {
  return new Map(entries.map((entry) => [entry.name, entry]));
}

export function resolveSkillsRoot(): string {
  return path.join(process.cwd(), "agent-skills");
}

/** Name + description only — safe to put in front of the model for
 * every registered skill, every call, regardless of what's loaded. */
export function listSkillMetadata(registry: SkillRegistry): SkillMetadata[] {
  return [...registry.values()]
    .map((entry) => ({ name: entry.name, description: entry.description }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Discovered once at module load — "discover at application startup,"
 * literally. Mirrors PRODUCTION_TOOL_REGISTRY's own eager-singleton
 * pattern in src/tools/registry.ts. An invalid real bundle fails the
 * import loudly rather than silently registering something broken. */
export const PRODUCTION_SKILL_REGISTRY: SkillRegistry = buildSkillRegistry(
  discoverSkills(resolveSkillsRoot()),
);
