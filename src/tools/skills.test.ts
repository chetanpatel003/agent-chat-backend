import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it, expect, afterAll, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { makeTestUser, cleanupTestUsers } from "@/test-utils/db-fixtures";
import { discoverSkills, buildSkillRegistry } from "@/skills/registry";
import type { SkillRegistry } from "@/skills/types";
import { createLoadSkillTool, createReadSkillAssetTool, loadSkillTool, readSkillAssetTool } from "./skills";
import { PRODUCTION_TOOL_REGISTRY, toOpenRouterTools } from "./registry";

const createdUserIds: string[] = [];
afterAll(() => cleanupTestUsers(createdUserIds));

async function user(label: string) {
  const u = await makeTestUser(label);
  createdUserIds.push(u.id);
  return u;
}

async function setUpRun(ownerId: string) {
  const chat = await prisma.chat.create({ data: { userId: ownerId } });
  const run = await prisma.agentRun.create({
    data: { chatId: chat.id, userId: ownerId, idempotencyKey: randomUUID(), status: "RUNNING" },
  });
  return run;
}

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/** A fixture registry with one real skill ("fixture-skill") and one
 * supporting asset, built the same way the real agent-skills/ directory
 * is — through discoverSkills() against real files — so every security
 * check (realpath, extension, size) is exercised for real, not stubbed. */
function fixtureRegistry(): SkillRegistry {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skills-tool-test-"));
  tmpDirs.push(root);
  const skillDir = path.join(root, "fixture-skill");
  fs.mkdirSync(path.join(skillDir, "guides"), { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: fixture-skill\ndescription: A fixture skill for tool tests.\n---\nFixture instructions body.\n",
  );
  fs.writeFileSync(path.join(skillDir, "guides", "extra.md"), "Fixture supporting guidance.\n");
  return buildSkillRegistry(discoverSkills(root));
}

describe("load_skill", () => {
  it("loads a registered skill, persisting exactly one RunSkill record", async () => {
    const owner = await user("load-skill-first");
    const run = await setUpRun(owner.id);
    const tool = createLoadSkillTool(fixtureRegistry());

    const result = await tool.execute({ name: "fixture-skill" }, { agentRunId: run.id, userId: owner.id, invocationId: randomUUID() });

    expect(result.name).toBe("fixture-skill");
    expect(result.description).toBe("A fixture skill for tool tests.");
    expect(result.instructions).toBe("Fixture instructions body.");
    expect(result.previouslyLoaded).toBe(false);
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);

    const rows = await prisma.runSkill.findMany({ where: { agentRunId: run.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].skillName).toBe("fixture-skill");
    expect(rows[0].contentHash).toBe(result.contentHash);
  });

  it("repeated loading returns the same persisted version and creates no duplicate record", async () => {
    const owner = await user("load-skill-repeat");
    const run = await setUpRun(owner.id);
    const tool = createLoadSkillTool(fixtureRegistry());

    const first = await tool.execute({ name: "fixture-skill" }, { agentRunId: run.id, userId: owner.id, invocationId: randomUUID() });
    expect(first.previouslyLoaded).toBe(false);

    const second = await tool.execute({ name: "fixture-skill" }, { agentRunId: run.id, userId: owner.id, invocationId: randomUUID() });
    expect(second.previouslyLoaded).toBe(true);
    expect(second.contentHash).toBe(first.contentHash);
    expect(second.instructions).toBe(first.instructions);

    const rows = await prisma.runSkill.findMany({ where: { agentRunId: run.id } });
    expect(rows).toHaveLength(1);
  });

  it("re-entry (a fresh tool instance, same agentRunId) restores the same loaded skill version", async () => {
    const owner = await user("load-skill-reentry");
    const run = await setUpRun(owner.id);
    const registry = fixtureRegistry();

    const firstEntry = await createLoadSkillTool(registry).execute(
      { name: "fixture-skill" },
      { agentRunId: run.id, userId: owner.id, invocationId: randomUUID() },
    );

    // Simulate re-entry: a brand new tool instance (as a fresh process
    // re-entering this same AgentRun would construct), same registry
    // content, same agentRunId.
    const reentry = await createLoadSkillTool(registry).execute(
      { name: "fixture-skill" },
      { agentRunId: run.id, userId: owner.id, invocationId: randomUUID() },
    );

    expect(reentry.previouslyLoaded).toBe(true);
    expect(reentry.contentHash).toBe(firstEntry.contentHash);
    const rows = await prisma.runSkill.findMany({ where: { agentRunId: run.id } });
    expect(rows).toHaveLength(1);
  });

  it("refuses to silently serve new content when the skill's file changed since this run first loaded it", async () => {
    const owner = await user("load-skill-changed");
    const run = await setUpRun(owner.id);

    // Simulate "this run loaded version A before a redeploy changed the
    // file" by directly persisting a RunSkill row with a hash that does
    // not match the current registry's content.
    await prisma.runSkill.create({
      data: { agentRunId: run.id, skillName: "fixture-skill", contentHash: "stale-hash-from-before-redeploy" },
    });

    const tool = createLoadSkillTool(fixtureRegistry());
    await expect(tool.execute({ name: "fixture-skill" }, { agentRunId: run.id, userId: owner.id, invocationId: randomUUID() })).rejects.toThrow(
      /changed since this run first loaded it/,
    );

    // The stale row must be left exactly as it was — never silently
    // overwritten with the new hash.
    const rows = await prisma.runSkill.findMany({ where: { agentRunId: run.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].contentHash).toBe("stale-hash-from-before-redeploy");
  });

  it("two concurrent duplicate loads for the same run never create duplicate records", async () => {
    const owner = await user("load-skill-concurrent");
    const run = await setUpRun(owner.id);
    const registry = fixtureRegistry();

    const [a, b] = await Promise.all([
      createLoadSkillTool(registry).execute({ name: "fixture-skill" }, { agentRunId: run.id, userId: owner.id, invocationId: randomUUID() }),
      createLoadSkillTool(registry).execute({ name: "fixture-skill" }, { agentRunId: run.id, userId: owner.id, invocationId: randomUUID() }),
    ]);

    expect(a.contentHash).toBe(b.contentHash);
    const rows = await prisma.runSkill.findMany({ where: { agentRunId: run.id } });
    expect(rows).toHaveLength(1);
  });

  it("rejects an unregistered skill name", async () => {
    const owner = await user("load-skill-unknown");
    const run = await setUpRun(owner.id);
    const tool = createLoadSkillTool(fixtureRegistry());

    await expect(
      tool.execute({ name: "no-such-skill" }, { agentRunId: run.id, userId: owner.id, invocationId: randomUUID() }),
    ).rejects.toThrow(/No skill named/);

    expect(await prisma.runSkill.count({ where: { agentRunId: run.id } })).toBe(0);
  });
});

describe("read_skill_asset", () => {
  it("reads an approved asset after the skill has been loaded", async () => {
    const owner = await user("read-asset-ok");
    const run = await setUpRun(owner.id);
    const registry = fixtureRegistry();
    await createLoadSkillTool(registry).execute({ name: "fixture-skill" }, { agentRunId: run.id, userId: owner.id, invocationId: randomUUID() });

    const result = await createReadSkillAssetTool(registry).execute(
      { skillName: "fixture-skill", assetPath: "guides/extra.md" },
      { agentRunId: run.id, userId: owner.id, invocationId: randomUUID() },
    );

    expect(result.content).toBe("Fixture supporting guidance.\n");
    expect(result.assetPath).toBe("guides/extra.md");
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses to read an asset before the skill has been loaded via load_skill", async () => {
    const owner = await user("read-asset-not-loaded");
    const run = await setUpRun(owner.id);
    const registry = fixtureRegistry();

    await expect(
      createReadSkillAssetTool(registry).execute(
        { skillName: "fixture-skill", assetPath: "guides/extra.md" },
        { agentRunId: run.id, userId: owner.id, invocationId: randomUUID() },
      ),
    ).rejects.toThrow(/must be loaded with load_skill/);
  });

  it("rejects an unknown skill name", async () => {
    const owner = await user("read-asset-unknown-skill");
    const run = await setUpRun(owner.id);
    await expect(
      createReadSkillAssetTool(fixtureRegistry()).execute(
        { skillName: "no-such-skill", assetPath: "guides/extra.md" },
        { agentRunId: run.id, userId: owner.id, invocationId: randomUUID() },
      ),
    ).rejects.toThrow(/No skill named/);
  });

  it("rejects an unknown asset path for an otherwise-loaded skill", async () => {
    const owner = await user("read-asset-unknown-asset");
    const run = await setUpRun(owner.id);
    const registry = fixtureRegistry();
    await createLoadSkillTool(registry).execute({ name: "fixture-skill" }, { agentRunId: run.id, userId: owner.id, invocationId: randomUUID() });

    await expect(
      createReadSkillAssetTool(registry).execute(
        { skillName: "fixture-skill", assetPath: "guides/does-not-exist.md" },
        { agentRunId: run.id, userId: owner.id, invocationId: randomUUID() },
      ),
    ).rejects.toThrow(/No asset named/);
  });

  it("rejects a path-traversal attempt through the real tool, not just the underlying resolver", async () => {
    const owner = await user("read-asset-traversal");
    const run = await setUpRun(owner.id);
    const registry = fixtureRegistry();
    await createLoadSkillTool(registry).execute({ name: "fixture-skill" }, { agentRunId: run.id, userId: owner.id, invocationId: randomUUID() });

    await expect(
      createReadSkillAssetTool(registry).execute(
        { skillName: "fixture-skill", assetPath: "../../../../etc/passwd" },
        { agentRunId: run.id, userId: owner.id, invocationId: randomUUID() },
      ),
    ).rejects.toThrow(/No asset named/);
  });

  it("rejects an absolute path through the real tool", async () => {
    const owner = await user("read-asset-absolute");
    const run = await setUpRun(owner.id);
    const registry = fixtureRegistry();
    await createLoadSkillTool(registry).execute({ name: "fixture-skill" }, { agentRunId: run.id, userId: owner.id, invocationId: randomUUID() });

    await expect(
      createReadSkillAssetTool(registry).execute(
        { skillName: "fixture-skill", assetPath: "/etc/passwd" },
        { agentRunId: run.id, userId: owner.id, invocationId: randomUUID() },
      ),
    ).rejects.toThrow(/No asset named/);
  });

  it("rejects an unsupported extension through the real tool", async () => {
    const owner = await user("read-asset-extension");
    const run = await setUpRun(owner.id);
    const registry = fixtureRegistry();
    const skill = registry.get("fixture-skill")!;
    fs.writeFileSync(path.join(skill.dir, "notes.txt"), "plain text\n");
    await createLoadSkillTool(registry).execute({ name: "fixture-skill" }, { agentRunId: run.id, userId: owner.id, invocationId: randomUUID() });

    await expect(
      createReadSkillAssetTool(registry).execute(
        { skillName: "fixture-skill", assetPath: "notes.txt" },
        { agentRunId: run.id, userId: owner.id, invocationId: randomUUID() },
      ),
    ).rejects.toThrow(/No asset named/);
  });
});

describe("production tool registration", () => {
  it("both skill tools are registered in PRODUCTION_TOOL_REGISTRY", () => {
    expect(PRODUCTION_TOOL_REGISTRY.get("load_skill")).toBe(loadSkillTool);
    expect(PRODUCTION_TOOL_REGISTRY.get("read_skill_asset")).toBe(readSkillAssetTool);
  });

  it("OpenRouter tool schemas are generated from each tool's own Zod input schema", () => {
    const specs = toOpenRouterTools(PRODUCTION_TOOL_REGISTRY);
    const byName = new Map(specs.map((s) => [s.function.name, s]));

    expect(byName.get("load_skill")?.function.parameters).toEqual({
      type: "object",
      properties: { name: { type: "string", minLength: 1, maxLength: 64 } },
      required: ["name"],
      additionalProperties: false,
    });

    expect(byName.get("read_skill_asset")?.function.parameters).toMatchObject({
      type: "object",
      required: ["skillName", "assetPath"],
    });
  });
});
