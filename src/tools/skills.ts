import fs from "node:fs";
import crypto from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { resolveApprovedAsset } from "@/skills/paths";
import type { SkillRegistry } from "@/skills/types";
import { PRODUCTION_SKILL_REGISTRY } from "@/skills/registry";
import type { ToolDefinition } from "./types";
import { TOOL_DISPLAY } from "./display";

// Checked empirically with a standalone diagnostic script against the
// real Neon database, not assumed from the decisions/0009 precedent:
// that precedent was documented for a hand-added raw-SQL *partial*
// index, but this constraint is a normal composite unique index
// declared directly in schema.prisma. Turns out this driver-adapter
// client (Prisma 7 + @prisma/adapter-pg) reports the *same*
// `driverAdapterError.cause.constraint.index` shape for both — never
// the naive `{ target: string[] }` shape standard Prisma guidance
// describes. Confirmed directly, not guessed from the prior case.
const RUN_SKILL_UNIQUE_INDEX = "RunSkill_agentRunId_skillName_key";

function isDuplicateRunSkill(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return false;
  }
  const meta = error.meta as
    | { driverAdapterError?: { cause?: { constraint?: { index?: string } } } }
    | undefined;
  return meta?.driverAdapterError?.cause?.constraint?.index === RUN_SKILL_UNIQUE_INDEX;
}

const LoadSkillInputSchema = z.object({
  name: z.string().min(1).max(64),
});
const LoadSkillOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
  contentHash: z.string(),
  previouslyLoaded: z.boolean(),
});
type LoadSkillOutput = z.infer<typeof LoadSkillOutputSchema>;

/**
 * Persists (or re-confirms) that `agentRunId` has loaded `skillName` at
 * exactly `contentHash`. Returns the existing row if one already exists
 * — including one created by a sibling call that just lost a race on
 * the same unique constraint — never creating a duplicate. Throws a
 * plain, clear Error (not a bespoke error type) if a prior load under
 * this exact run recorded a *different* hash than the registry's
 * current one: that can only mean the skill file changed on disk since
 * this run first loaded it (e.g. a redeploy between a crash and a
 * retry), and silently serving the new content in its place would be
 * exactly the "silently loading different instructions" this
 * checkpoint's requirements forbid.
 */
async function recordSkillLoad(
  agentRunId: string,
  skillName: string,
  contentHash: string,
): Promise<{ previouslyLoaded: boolean }> {
  const existing = await prisma.runSkill.findUnique({
    where: { agentRunId_skillName: { agentRunId, skillName } },
  });
  if (existing) {
    if (existing.contentHash !== contentHash) {
      throw new Error(
        `Skill "${skillName}" has changed since this run first loaded it ` +
          `(loaded version ${existing.contentHash.slice(0, 12)}…, current version ${contentHash.slice(0, 12)}…) — ` +
          "refusing to silently switch versions mid-run.",
      );
    }
    return { previouslyLoaded: true };
  }

  try {
    await prisma.runSkill.create({ data: { agentRunId, skillName, contentHash } });
    return { previouslyLoaded: false };
  } catch (error) {
    if (isDuplicateRunSkill(error)) {
      // A concurrent sibling call won the insert race between our read
      // and our write. Re-read rather than assume: the row that landed
      // is authoritative, and since both racers computed contentHash
      // from the same in-memory registry entry, it must match — but
      // re-verify rather than assume, for the same reason recordSkillLoad
      // never assumes anything else about a pre-existing row.
      const landed = await prisma.runSkill.findUniqueOrThrow({
        where: { agentRunId_skillName: { agentRunId, skillName } },
      });
      if (landed.contentHash !== contentHash) {
        throw new Error(
          `Skill "${skillName}" was loaded concurrently with a different content hash ` +
            `(${landed.contentHash.slice(0, 12)}… vs ${contentHash.slice(0, 12)}…) — refusing to proceed.`,
        );
      }
      return { previouslyLoaded: true };
    }
    throw error;
  }
}

/**
 * `load_skill` — loads one registered skill's main SKILL.md instructions
 * on demand. A factory, not a bare export, so tests can bind it to a
 * fixture registry instead of the real `agent-skills/` directory,
 * exactly the dependency-injection pattern `executeAgentTurn` already
 * uses for the tool registry and the realtime publisher.
 */
export function createLoadSkillTool(
  skillRegistry: SkillRegistry,
): ToolDefinition<z.infer<typeof LoadSkillInputSchema>, LoadSkillOutput> {
  return {
    name: "load_skill",
    display: TOOL_DISPLAY.load_skill,
    description:
      "Load a registered skill's full instructions by its exact name. Call this only when the skill is relevant to the user's current request.",
    inputSchema: LoadSkillInputSchema,
    outputSchema: LoadSkillOutputSchema,
    async execute(input, context) {
      const skill = skillRegistry.get(input.name);
      if (!skill) {
        throw new Error(`No skill named "${input.name}" is registered.`);
      }

      const { previouslyLoaded } = await recordSkillLoad(
        context.agentRunId,
        skill.name,
        skill.contentHash,
      );

      return {
        name: skill.name,
        description: skill.description,
        instructions: skill.instructions,
        contentHash: skill.contentHash,
        previouslyLoaded,
      };
    },
  };
}

const ReadSkillAssetInputSchema = z.object({
  skillName: z.string().min(1).max(64),
  assetPath: z.string().min(1).max(256),
});
const ReadSkillAssetOutputSchema = z.object({
  skillName: z.string(),
  assetPath: z.string(),
  content: z.string(),
  contentHash: z.string(),
});
type ReadSkillAssetOutput = z.infer<typeof ReadSkillAssetOutputSchema>;

/**
 * `read_skill_asset` — reads one approved supporting file inside an
 * already-loaded skill's own directory. Requiring the skill to have
 * been loaded first (checked against the durable RunSkill row, not an
 * in-memory flag — so it holds identically across a crash/re-entry) is
 * enforced here, in `execute()`, using the existing tool-execution
 * mechanism; no new branch in the agent loop itself.
 */
export function createReadSkillAssetTool(
  skillRegistry: SkillRegistry,
): ToolDefinition<z.infer<typeof ReadSkillAssetInputSchema>, ReadSkillAssetOutput> {
  return {
    name: "read_skill_asset",
    display: TOOL_DISPLAY.read_skill_asset,
    description:
      "Read one approved supporting file (e.g. a guide referenced by a loaded skill's instructions) by its relative path. The skill must already be loaded via load_skill.",
    inputSchema: ReadSkillAssetInputSchema,
    outputSchema: ReadSkillAssetOutputSchema,
    async execute(input, context) {
      const skill = skillRegistry.get(input.skillName);
      if (!skill) {
        throw new Error(`No skill named "${input.skillName}" is registered.`);
      }

      const loaded = await prisma.runSkill.findUnique({
        where: { agentRunId_skillName: { agentRunId: context.agentRunId, skillName: skill.name } },
      });
      if (!loaded) {
        throw new Error(`Skill "${skill.name}" must be loaded with load_skill before reading its assets.`);
      }

      const asset = resolveApprovedAsset(skill, input.assetPath);
      if (!asset) {
        throw new Error(`No asset named "${input.assetPath}" is approved for skill "${skill.name}".`);
      }

      const content = fs.readFileSync(asset.absolutePath, "utf8");
      const contentHash = crypto.createHash("sha256").update(content, "utf8").digest("hex");

      return {
        skillName: skill.name,
        assetPath: asset.relativePath,
        content,
        contentHash,
      };
    },
  };
}

export const loadSkillTool = createLoadSkillTool(PRODUCTION_SKILL_REGISTRY);
export const readSkillAssetTool = createReadSkillAssetTool(PRODUCTION_SKILL_REGISTRY);
