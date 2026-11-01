import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import {
  discoverSkills,
  buildSkillRegistry,
  resolveSkillsRoot,
  listSkillMetadata,
  PRODUCTION_SKILL_REGISTRY,
  SkillDiscoveryError,
} from "./registry";

const tmpDirs: string[] = [];

function makeTmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-skills-test-"));
  tmpDirs.push(dir);
  return dir;
}

function writeSkill(
  root: string,
  dirName: string,
  frontmatter: string,
  body = "Some real instructions go here.\n",
) {
  const skillDir = path.join(root, dirName);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), `${frontmatter}\n${body}`);
  return skillDir;
}

function validFrontmatter(name: string, description = "A real, useful description.") {
  return `---\nname: ${name}\ndescription: ${description}\n---`;
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("discoverSkills — the real agent-skills/ directory", () => {
  it("discovers all three required skills with real, validated metadata", () => {
    const entries = discoverSkills(resolveSkillsRoot());
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(["image-analysis", "image-editing", "video-editing"]);
    for (const entry of entries) {
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.instructions.length).toBeGreaterThan(0);
      expect(entry.contentHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("discovers image-editing's guides/composition.md as an approved asset", () => {
    const entries = discoverSkills(resolveSkillsRoot());
    const imageEditing = entries.find((e) => e.name === "image-editing")!;
    expect(imageEditing.assets.has("guides/composition.md")).toBe(true);
  });

  it("PRODUCTION_SKILL_REGISTRY (the eager startup singleton) matches a fresh discoverSkills() call", () => {
    expect(PRODUCTION_SKILL_REGISTRY.size).toBe(3);
    expect([...PRODUCTION_SKILL_REGISTRY.keys()].sort()).toEqual([
      "image-analysis",
      "image-editing",
      "video-editing",
    ]);
  });

  it("listSkillMetadata exposes only name + description, sorted, never instructions or a filesystem path", () => {
    const metadata = listSkillMetadata(PRODUCTION_SKILL_REGISTRY);
    expect(metadata).toEqual([
      { name: "image-analysis", description: expect.any(String) },
      { name: "image-editing", description: expect.any(String) },
      { name: "video-editing", description: expect.any(String) },
    ]);
    for (const entry of metadata) {
      expect(Object.keys(entry).sort()).toEqual(["description", "name"]);
    }
  });
});

describe("discoverSkills — bundle validation (fixture directories)", () => {
  it("rejects a skill directory with no SKILL.md (missing frontmatter entirely)", () => {
    const root = makeTmpRoot();
    fs.mkdirSync(path.join(root, "no-skill-md"));
    expect(() => discoverSkills(root)).toThrow(SkillDiscoveryError);
    try {
      discoverSkills(root);
    } catch (error) {
      expect((error as SkillDiscoveryError).problems[0]).toMatch(/missing SKILL\.md/);
    }
  });

  it("rejects malformed YAML frontmatter", () => {
    const root = makeTmpRoot();
    writeSkill(root, "bad-yaml", "---\nname: [unterminated\n---");
    expect(() => discoverSkills(root)).toThrow(/malformed YAML frontmatter/);
  });

  it("rejects frontmatter missing the name field", () => {
    const root = makeTmpRoot();
    writeSkill(root, "no-name", "---\ndescription: has a description only\n---");
    expect(() => discoverSkills(root)).toThrow(/invalid frontmatter/);
  });

  it("rejects frontmatter missing the description field", () => {
    const root = makeTmpRoot();
    writeSkill(root, "no-description", "---\nname: no-description\n---");
    expect(() => discoverSkills(root)).toThrow(/invalid frontmatter/);
  });

  it("rejects two different skill directories declaring the same skill name", () => {
    const root = makeTmpRoot();
    writeSkill(root, "dup-a", validFrontmatter("shared-name"), "First directory's instructions.\n");
    writeSkill(root, "dup-b", validFrontmatter("shared-name"), "Second directory's instructions.\n");
    expect(() => discoverSkills(root)).toThrow(/duplicate skill name/);
  });

  it("rejects a SKILL.md larger than the configured size limit", () => {
    const root = makeTmpRoot();
    const huge = "x".repeat(40 * 1024);
    writeSkill(root, "oversized", validFrontmatter("oversized"), huge);
    expect(() => discoverSkills(root)).toThrow(/exceeds/);
  });

  it("rejects an empty SKILL.md", () => {
    const root = makeTmpRoot();
    const skillDir = path.join(root, "empty-file");
    fs.mkdirSync(skillDir);
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "");
    expect(() => discoverSkills(root)).toThrow(/file is empty/);
  });

  it("rejects a skill name that isn't lowercase kebab-case", () => {
    const root = makeTmpRoot();
    writeSkill(root, "Bad_Name", validFrontmatter("Bad_Name"));
    expect(() => discoverSkills(root)).toThrow(/invalid frontmatter/);
  });

  it("rejects an empty instructions body even with otherwise-valid frontmatter", () => {
    const root = makeTmpRoot();
    const skillDir = path.join(root, "empty-body");
    fs.mkdirSync(skillDir);
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), `${validFrontmatter("empty-body")}\n   \n`);
    expect(() => discoverSkills(root)).toThrow(/empty instructions body/);
  });

  it("aggregates every problem across every bad bundle into one thrown error, not just the first", () => {
    const root = makeTmpRoot();
    fs.mkdirSync(path.join(root, "missing-one"));
    writeSkill(root, "bad-name-two", validFrontmatter("Not Kebab Case"));
    try {
      discoverSkills(root);
      expect.fail("expected discoverSkills to throw");
    } catch (error) {
      const problems = (error as SkillDiscoveryError).problems;
      expect(problems.length).toBe(2);
    }
  });

  it("accepts a well-formed skill bundle with a supporting asset in a subdirectory", () => {
    const root = makeTmpRoot();
    const skillDir = writeSkill(root, "good-skill", validFrontmatter("good-skill"));
    fs.mkdirSync(path.join(skillDir, "guides"));
    fs.writeFileSync(path.join(skillDir, "guides", "extra.md"), "Supporting guidance.\n");

    const entries = discoverSkills(root);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("good-skill");
    expect(entries[0].assets.has("guides/extra.md")).toBe(true);
  });

  it("silently excludes (does not fail the whole bundle for) an asset with an unapproved extension", () => {
    const root = makeTmpRoot();
    const skillDir = writeSkill(root, "mixed-assets", validFrontmatter("mixed-assets"));
    fs.writeFileSync(path.join(skillDir, "script.sh"), "#!/bin/sh\necho hi\n");

    const entries = discoverSkills(root);
    expect(entries).toHaveLength(1);
    expect(entries[0].assets.has("script.sh")).toBe(false);
  });

  it("silently excludes an oversized asset without failing the whole bundle", () => {
    const root = makeTmpRoot();
    const skillDir = writeSkill(root, "big-asset", validFrontmatter("big-asset"));
    fs.writeFileSync(path.join(skillDir, "guide.md"), "y".repeat(70 * 1024));

    const entries = discoverSkills(root);
    expect(entries[0].assets.has("guide.md")).toBe(false);
  });

  it("excludes (at discovery time) a symlinked asset that escapes the skill directory", () => {
    const root = makeTmpRoot();
    const skillDir = writeSkill(root, "symlink-skill", validFrontmatter("symlink-skill"));
    const secretPath = path.join(root, "secret.md");
    fs.writeFileSync(secretPath, "outside content\n");
    fs.symlinkSync(secretPath, path.join(skillDir, "escape.md"));

    const entries = discoverSkills(root);
    expect(entries).toHaveLength(1);
    expect(entries[0].assets.has("escape.md")).toBe(false);
  });

  it("builds a registry map keyed by skill name from discovered entries", () => {
    const root = makeTmpRoot();
    writeSkill(root, "skill-a", validFrontmatter("skill-a"));
    writeSkill(root, "skill-b", validFrontmatter("skill-b"));
    const registry = buildSkillRegistry(discoverSkills(root));
    expect(registry.get("skill-a")?.name).toBe("skill-a");
    expect(registry.get("skill-b")?.name).toBe("skill-b");
    expect(registry.get("missing")).toBeUndefined();
  });
});
