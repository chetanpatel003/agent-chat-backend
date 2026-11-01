import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { normalizeRelativePath, resolveApprovedAsset } from "./paths";
import { discoverSkills } from "./registry";
import type { SkillEntry } from "./types";

describe("normalizeRelativePath", () => {
  it("accepts an ordinary nested relative path", () => {
    expect(normalizeRelativePath("guides/composition.md")).toBe("guides/composition.md");
  });

  it("rejects an absolute path", () => {
    expect(normalizeRelativePath("/etc/passwd")).toBeNull();
  });

  it("rejects a .. traversal segment", () => {
    expect(normalizeRelativePath("../../../../etc/passwd")).toBeNull();
    expect(normalizeRelativePath("guides/../../secret.md")).toBeNull();
  });

  it("rejects a percent-encoded traversal attempt", () => {
    expect(normalizeRelativePath("%2e%2e%2f%2e%2e%2fetc%2fpasswd")).toBeNull();
    expect(normalizeRelativePath("guides%2f..%2f..%2fsecret.md")).toBeNull();
  });

  it("rejects a null byte", () => {
    expect(normalizeRelativePath("guide.md\0.txt")).toBeNull();
  });

  it("rejects an empty string", () => {
    expect(normalizeRelativePath("")).toBeNull();
  });
});

describe("resolveApprovedAsset", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  });

  function buildFixtureSkill(): { root: string; skill: SkillEntry } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-paths-test-"));
    tmpDirs.push(root);
    const skillDir = path.join(root, "fixture-skill");
    fs.mkdirSync(path.join(skillDir, "guides"), { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: fixture-skill\ndescription: a fixture.\n---\nInstructions.\n",
    );
    fs.writeFileSync(path.join(skillDir, "guides", "extra.md"), "Extra guidance.\n");
    const [skill] = discoverSkills(root);
    return { root, skill };
  }

  it("resolves an approved, discovered asset and returns its content hash input unchanged", () => {
    const { skill } = buildFixtureSkill();
    const resolved = resolveApprovedAsset(skill, "guides/extra.md");
    expect(resolved).not.toBeNull();
    expect(resolved!.relativePath).toBe("guides/extra.md");
    expect(fs.readFileSync(resolved!.absolutePath, "utf8")).toBe("Extra guidance.\n");
  });

  it("rejects an asset path that was never discovered (a map-lookup miss), regardless of shape", () => {
    const { skill } = buildFixtureSkill();
    expect(resolveApprovedAsset(skill, "guides/does-not-exist.md")).toBeNull();
  });

  it("rejects ../ traversal", () => {
    const { skill } = buildFixtureSkill();
    expect(resolveApprovedAsset(skill, "../../../etc/passwd")).toBeNull();
  });

  it("rejects an absolute filesystem path", () => {
    const { skill } = buildFixtureSkill();
    expect(resolveApprovedAsset(skill, "/etc/passwd")).toBeNull();
  });

  it("rejects an encoded traversal attempt", () => {
    const { skill } = buildFixtureSkill();
    expect(resolveApprovedAsset(skill, "guides%2f..%2f..%2fsecret.md")).toBeNull();
  });

  it("rejects a symlink inside the skill directory that escapes to an external file", () => {
    const { root, skill } = buildFixtureSkill();
    const secretPath = path.join(root, "secret-outside-skill.md");
    fs.writeFileSync(secretPath, "top secret\n");
    const escapeLinkPath = path.join(skill.dir, "guides", "escape.md");
    fs.symlinkSync(secretPath, escapeLinkPath);

    // Even though the symlink physically exists on disk right now, it
    // was never part of the safe discovery-time walk's approved map —
    // resolveApprovedAsset only ever looks up pre-vetted keys.
    expect(resolveApprovedAsset(skill, "guides/escape.md")).toBeNull();
  });

  it("rejects an unsupported file extension even if somehow present in the directory", () => {
    const { skill } = buildFixtureSkill();
    fs.writeFileSync(path.join(skill.dir, "notes.txt"), "plain text\n");
    expect(resolveApprovedAsset(skill, "notes.txt")).toBeNull();
  });

  it("re-verifies containment at read time even for a previously-approved asset (TOCTOU defense)", () => {
    const { root, skill } = buildFixtureSkill();
    const assetPath = path.join(skill.dir, "guides", "extra.md");
    const outsidePath = path.join(root, "swapped-in-after-discovery.md");
    fs.writeFileSync(outsidePath, "swapped content\n");
    // Simulate the file being replaced by a symlink pointing outside the
    // skill directory after discovery already ran.
    fs.rmSync(assetPath);
    fs.symlinkSync(outsidePath, assetPath);

    expect(resolveApprovedAsset(skill, "guides/extra.md")).toBeNull();
  });
});
