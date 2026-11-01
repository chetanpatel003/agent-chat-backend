import { z } from "zod";
import type { ToolDefinition } from "./types";
import { startMagicaRun } from "@/providers/magica";
import { persistProviderRunId, pollMagicaRunToCompletion, reconcileMagicaRun, durableWait, type DurableWait } from "@/services/magica-run";

/**
 * Real Magica tools, built on the Phase 3.2 provider adapter and
 * orchestration primitives (`src/providers/magica.ts`,
 * `src/services/magica-run.ts`) — no new provider abstraction, no
 * duplicated start/persist/poll/reconcile logic: `createMagicaTool`
 * below is the one place that logic lives, the same factory shape as
 * `createMagicaFixtureTool` (checkpoint 3.2) and
 * `createLoadSkillTool`/`createReadSkillAssetTool` (checkpoint 2.5) —
 * an injectable `waitFn` for testability, not a generic workflow
 * engine.
 *
 * Checkpoint 3.3: `generate_image` was built first and live-verified
 * (project-docs/magica/LIVE_VERIFICATION.md) before the remaining
 * three — `edit_image`, `crop_image`, `merge_videos` — were added,
 * per this checkpoint's own "prove the path first" instruction. All
 * four reuse the exact same `createMagicaTool` factory; none of the
 * other three were independently live-verified (not required once the
 * shared mechanism was already proven) — their output shapes are
 * therefore unverified against a real response, stated plainly in
 * API_CONTRACTS.md rather than assumed.
 */

// ---------- Shared output handling ----------
// Corrected against one real live generate_image call — see
// project-docs/magica/LIVE_VERIFICATION.md — not the assumption this
// was first written against. The one documented example in
// EXECUTION_API.md (an unrelated model, nano_banana_pro) showed
// `{ images: [...] }`; the real, live gpt-image-2-text response was
// actually `{ result: [...], provider: "fal", creditUsed,
// resultMetadata: [...] }` — a completely different field name.
// `extractImageUrls` checks both: `result` because it's now
// confirmed real for this model, `images` because it remains the one
// documented (if unverified-for-this-model) shape another Magica node
// might use. Always preserves the complete raw output regardless of
// which, or neither, matches.
export const MagicaToolOutputSchema = z.object({
  raw: z.unknown(),
  images: z.array(z.string()).optional(),
  /** Captured and persisted as plain descriptive data only — never
   * converted to credits or settled against the ledger. The pricing-
   * unit discrepancy (project-docs/magica/CREDIT_ESTIMATION.md)
   * remains unresolved; this field exists to record evidence toward
   * resolving it, not to act on it. */
  creditUsed: z.number().optional(),
});
export type MagicaToolOutput = z.infer<typeof MagicaToolOutputSchema>;

function stringArrayField(output: unknown, field: string): string[] | undefined {
  if (!output || typeof output !== "object" || !(field in output)) return undefined;
  const value = (output as Record<string, unknown>)[field];
  if (Array.isArray(value) && value.length > 0 && value.every((i) => typeof i === "string")) {
    return value as string[];
  }
  return undefined;
}

function extractImageUrls(output: unknown): string[] | undefined {
  return stringArrayField(output, "result") ?? stringArrayField(output, "images");
}

function normalizeMagicaOutput(rawOutput: unknown, creditUsed: number | undefined): MagicaToolOutput {
  const images = extractImageUrls(rawOutput);
  return {
    raw: rawOutput,
    ...(images ? { images } : {}),
    ...(creditUsed !== undefined ? { creditUsed } : {}),
  };
}

// ---------- Shared factory ----------

export function createMagicaTool<TInput>(options: {
  name: string;
  description: string;
  nodeType: string;
  subModelId?: string;
  inputSchema: z.ZodType<TInput>;
  waitFn?: DurableWait;
}): ToolDefinition<TInput, MagicaToolOutput> {
  const { name, description, nodeType, subModelId, inputSchema, waitFn = durableWait } = options;
  return {
    name,
    description,
    inputSchema,
    outputSchema: MagicaToolOutputSchema,
    async execute(input, context) {
      const started = await startMagicaRun(nodeType, input as Record<string, unknown>, subModelId);

      // Persisted immediately after the 202, before any poll/wait —
      // checkpoint 3.2's own requirement. A failure to apply this
      // write means Magica may have already started a billable run we
      // can no longer track; never start a second one because of it.
      const persisted = await persistProviderRunId(context.invocationId, started.runId);
      if (!persisted.applied) {
        throw new Error(
          `Magica run ${started.runId} started but could not be durably recorded against invocation ${context.invocationId}`,
        );
      }

      const outcome = await pollMagicaRunToCompletion({
        agentRunId: context.agentRunId,
        providerRunId: started.runId,
        waitFn,
      });
      if (outcome.status === "failed") {
        throw new Error(outcome.errorMessage);
      }
      return normalizeMagicaOutput(outcome.output, outcome.creditUsed);
    },
    async reconcile(invocation) {
      const outcome = await reconcileMagicaRun(invocation, waitFn);
      if (outcome.status === "completed") {
        return { status: "completed" as const, output: normalizeMagicaOutput(outcome.output, outcome.creditUsed) };
      }
      return outcome;
    },
  };
}

// ---------- Shared GPT Image 2 field schemas ----------
// Exact field list, constraints, and defaults copied from the real
// discovered schema (project-docs/magica/schemas/gpt-image-2-text.json),
// not re-derived or guessed. Exported for reuse once edit_image is
// built (same fields, plus uploadedImages).

export const GPT_IMAGE_2_SIZE_PRESETS = [
  "Auto",
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "2048x2048",
  "2048x1152",
  "3840x2160",
  "2160x3840",
] as const;

const CustomSizeSchema = z
  .object({
    width: z.number().int().min(1024).max(3840),
    height: z.number().int().min(1024).max(3840),
  })
  .refine((s) => s.width % 16 === 0 && s.height % 16 === 0, {
    message: "width and height must each be a multiple of 16",
  })
  .refine((s) => Math.max(s.width, s.height) / Math.min(s.width, s.height) <= 3, {
    message: "the long-to-short side ratio must be 3:1 or less",
  })
  .refine((s) => s.width * s.height >= 655_360 && s.width * s.height <= 8_294_400, {
    message: "total pixels must be between 655,360 and 8,294,400",
  });

export const GptImage2CommonFields = {
  size: z.union([z.enum(GPT_IMAGE_2_SIZE_PRESETS), CustomSizeSchema]).optional(),
  quality: z.enum(["High", "Medium", "Low"]).optional(),
  background: z.enum(["Auto", "Opaque"]).optional(),
  n: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
  output_format: z.enum(["PNG", "JPEG", "WebP"]).optional(),
};

export const PublicHttpsUrlSchema = z
  .string()
  .url()
  .refine((u) => u.startsWith("https://"), { message: "must be a public HTTPS URL" });

// ---------- generate_image (GPT Image 2, text-to-image) ----------

const GenerateImageInputSchema = z.object({
  prompt: z.string().min(1).max(4000),
  ...GptImage2CommonFields,
});

export const generateImageTool: ToolDefinition<z.infer<typeof GenerateImageInputSchema>, MagicaToolOutput> =
  createMagicaTool({
    name: "generate_image",
    description:
      "Generate a brand-new image from a text description, using GPT Image 2. Does not take an existing image as input — use edit_image to modify an existing image instead.",
    nodeType: "gpt_image_2",
    subModelId: "gpt-image-2-text",
    inputSchema: GenerateImageInputSchema,
  });

// ---------- edit_image (GPT Image 2, image editing) ----------
// Exact field list copied from
// project-docs/magica/schemas/gpt-image-2-edit.json: the same common
// fields as generate_image, plus the required uploadedImages array.
// Not live-verified independently — reuses the same createMagicaTool
// mechanism and output normalization already proven for
// generate_image; see API_CONTRACTS.md for this stated plainly as an
// unverified-output-shape limitation for this specific tool.

const EditImageInputSchema = z.object({
  prompt: z.string().min(1).max(4000),
  uploadedImages: z.array(PublicHttpsUrlSchema).min(1).max(10),
  ...GptImage2CommonFields,
});

export const editImageTool: ToolDefinition<z.infer<typeof EditImageInputSchema>, MagicaToolOutput> = createMagicaTool(
  {
    name: "edit_image",
    description:
      "Edit or modify 1-10 existing images using a text instruction describing the change, using GPT Image 2. Requires uploadedImages (public HTTPS URLs) — use generate_image to create a new image from scratch instead.",
    nodeType: "gpt_image_2",
    subModelId: "gpt-image-2-edit",
    inputSchema: EditImageInputSchema,
  },
);

// ---------- crop_image ----------
// Exact field list copied from project-docs/magica/schemas/crop-image.json.
// No mutual-exclusivity rule between the percent/px fields is enforced
// — the discovered schema doesn't document one either; both sets
// simply apply their own independent defaults when omitted.

const CropImageInputSchema = z.object({
  image_url: PublicHttpsUrlSchema,
  x_percent: z.number().min(0).max(100).optional(),
  y_percent: z.number().min(0).max(100).optional(),
  width_percent: z.number().min(0).max(100).optional(),
  height_percent: z.number().min(0).max(100).optional(),
  width_px: z.number().int().min(1).optional(),
  height_px: z.number().int().min(1).optional(),
  x_px: z.number().int().min(0).optional(),
  y_px: z.number().int().min(0).optional(),
});

export const cropImageTool: ToolDefinition<z.infer<typeof CropImageInputSchema>, MagicaToolOutput> = createMagicaTool(
  {
    name: "crop_image",
    description:
      "Crop an existing single image to a specific rectangular region, by percentage of the original or exact pixel coordinates — a purely geometric crop, no AI modification of pixel content.",
    nodeType: "crop_image",
    inputSchema: CropImageInputSchema,
  },
);

// ---------- merge_videos ----------
// `min(2)` is enforced here in application validation — the discovered
// schema (project-docs/magica/schemas/merge-videos.json) documents a
// 2-video minimum only in its field description text, not as a
// machine-checkable constraint. No duration/codec field is invented —
// none is documented.

const MergeVideosInputSchema = z.object({
  video_urls: z.array(PublicHttpsUrlSchema).min(2).max(100),
  transition: z.enum(["none", "fade", "dissolve"]).optional(),
});

export const mergeVideosTool: ToolDefinition<z.infer<typeof MergeVideosInputSchema>, MagicaToolOutput> =
  createMagicaTool({
    name: "merge_videos",
    description:
      "Combine 2 to 100 existing videos into a single video, in the given order, with an optional transition between clips.",
    nodeType: "merge_videos",
    inputSchema: MergeVideosInputSchema,
  });
