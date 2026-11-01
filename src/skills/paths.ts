import fs from "node:fs";
import path from "node:path";
import type { SkillEntry } from "./types";

export const MAX_SKILL_FILE_BYTES = 32 * 1024;
export const MAX_ASSET_FILE_BYTES = 64 * 1024;

/** The only asset content type this checkpoint approves — skill
 * content is guidance text, never executable code or binary assets
 * (deliberately narrow scope; see project-docs/DATABASE.md). */
export const APPROVED_ASSET_EXTENSIONS = [".md"];

/**
 * Normalizes a caller-supplied relative path for safe, exact lookup
 * against a skill's pre-discovered asset map. Returns null for anything
 * that is not a plain, contained relative path — absolute paths, null
 * bytes, `..` segments (including percent-encoded ones, decoded before
 * normalizing so an encoded traversal attempt is caught by the same
 * check, not silently inert for the wrong reason). This function never
 * touches the filesystem; it only decides whether a string is shaped
 * like something that could legitimately be a map key.
 */
export function normalizeRelativePath(input: string): string | null {
  if (typeof input !== "string" || input.length === 0) return null;
  if (input.includes("\0")) return null;

  let decoded = input;
  try {
    decoded = decodeURIComponent(input);
  } catch {
    // Not valid percent-encoding — fall through and normalize the raw
    // string as-is; it still can't contain a literal ".." this way.
  }

  if (path.isAbsolute(decoded) || decoded.startsWith("/") || decoded.startsWith("\\")) {
    return null;
  }

  const normalized = path.normalize(decoded).split(path.sep).join("/");
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  if (normalized.length === 0 || normalized === ".") return null;

  return normalized;
}

/**
 * Resolves a requested relative asset path against one already-
 * discovered skill, or returns null for any failure (unknown path,
 * traversal attempt, symlink escape, missing file, wrong extension,
 * oversized/empty file). Deliberately returns the same null for every
 * failure reason — a uniform "unknown asset" outcome, never leaking
 * which specific check tripped.
 *
 * Two independent layers, not one: (1) the requested path must exactly
 * match a key already in `skill.assets`, a map built from a safe,
 * realpath-contained directory walk at discovery time — this alone
 * defeats every traversal/absolute/encoded-path attempt, since none of
 * those strings can ever equal a legitimately-discovered relative path.
 * (2) even for a match, the file is re-resolved via `fs.realpathSync`
 * and re-contained against the skill's own realpath'd directory right
 * here, not trusted from the cached discovery-time value — closing the
 * gap where a file could have been replaced or symlinked after startup
 * (TOCTOU). Neither layer alone is "just a string-prefix check."
 */
export function resolveApprovedAsset(
  skill: SkillEntry,
  requestedPath: string,
): { relativePath: string; absolutePath: string } | null {
  const normalized = normalizeRelativePath(requestedPath);
  if (normalized === null) return null;

  const asset = skill.assets.get(normalized);
  if (!asset) return null;

  let real: string;
  try {
    real = fs.realpathSync(asset.absolutePath);
  } catch {
    return null;
  }
  const withinRoot = real === skill.dir || real.startsWith(skill.dir + path.sep);
  if (!withinRoot) return null;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(real);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_ASSET_FILE_BYTES) return null;
  if (!APPROVED_ASSET_EXTENSIONS.includes(path.extname(real))) return null;

  return { relativePath: normalized, absolutePath: real };
}
