import { z } from "zod";
import {
  PROVIDER_OUTCOME_UNKNOWN,
  PROVIDER_OUTPUT_INVALID,
  PROVIDER_RETRY_BLOCKED,
  ProviderOutcomeUnknownError,
  ProviderRunFailedError,
  ToolExecutionError,
  type ToolDefinition,
  type ToolExecutionContext,
} from "./types";
import { MagicaAmbiguousError, startMagicaRun } from "@/providers/magica";
import { prisma } from "@/lib/prisma";
import { extractMagicaMediaUrls } from "./magica-output";
import { toolDisplay } from "./display";
import type { ToolDisplay } from "@/contracts/run-event";
import { admitBillableRun, type AdmissionSpec } from "@/services/credit-admission";
import { mergeAdmissionCredits, resolveMergeSources } from "@/services/merge-admission";
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
// The per-tool field rules now live in one place, `extractMagicaMediaUrls`
// (tools/magica-output.ts), shared with archival and — via the persisted
// `images` — the chat UI. The complete raw output is always preserved; a
// completed run with no valid media is a PROVIDER_OUTPUT_INVALID failure.
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

/** Persisted shape: the complete raw output plus the canonical media URLs (`images`, for videos too). */
function normalizeMagicaOutput(toolName: string, rawOutput: unknown, creditUsed: number | undefined): MagicaToolOutput {
  const images = extractMagicaMediaUrls(toolName, rawOutput);
  return {
    raw: rawOutput,
    ...(images.length > 0 ? { images } : {}),
    ...(creditUsed !== undefined ? { creditUsed } : {}),
  };
}

const outputInvalidMessage = (toolName: string) =>
  `The ${toolName} run finished, but the provider returned no usable media. Nothing was shown; the user can try again.`;

/**
 * H1: an earlier call to this tool in the same AgentRun ended with an
 * unknown provider outcome — a further call (any arguments) could start a
 * second paid run, so it is refused before admission or any provider call.
 */
async function assertNoUnknownOutcome(toolName: string, context: ToolExecutionContext): Promise<void> {
  const earlier = await prisma.toolInvocation.findFirst({
    where: { agentRunId: context.agentRunId, toolName, errorCode: PROVIDER_OUTCOME_UNKNOWN, id: { not: context.invocationId } },
    select: { id: true },
  });
  if (earlier) {
    throw new ToolExecutionError(
      PROVIDER_RETRY_BLOCKED,
      `${toolName} was not run: an earlier ${toolName} request in this turn may still be running at the provider. ` +
        `Do not call ${toolName} again in this turn; tell the user the result may still arrive.`,
    );
  }
}

// ---------- Shared factory ----------

export function createMagicaTool<TInput>(options: {
  name: string;
  description: string;
  display?: ToolDisplay;
  nodeType: string;
  subModelId?: string;
  inputSchema: z.ZodType<TInput>;
  /** Required: every billable tool declares how its cost is checked before running. */
  /** May look up the caller's own data (e.g. measured video durations); runs before any provider call. */
  admission: (input: TInput, context: ToolExecutionContext) => AdmissionSpec | Promise<AdmissionSpec>;
  waitFn?: DurableWait;
}): ToolDefinition<TInput, MagicaToolOutput> {
  const { name, description, display, nodeType, subModelId, inputSchema, admission, waitFn = durableWait } = options;
  return {
    name,
    description,
    display: toolDisplay(name, display),
    inputSchema,
    outputSchema: MagicaToolOutputSchema,
    async execute(input, context) {
      await assertNoUnknownOutcome(name, context);
      // Before any provider call: refuses (coded error) rather than start an unaffordable or unpriced run.
      await admitBillableRun(context.userId, await admission(input, context));
      let started;
      try {
        started = await startMagicaRun(nodeType, input as Record<string, unknown>, subModelId);
      } catch (error) {
        // Ambiguous (network/timeout/5xx): the run may exist. Recorded as an
        // unknown outcome — never resubmitted, and further calls are blocked.
        if (error instanceof MagicaAmbiguousError) throw new ProviderOutcomeUnknownError(name, error.code);
        throw error;
      }

      // Persisted immediately after the 202, before any poll/wait —
      // checkpoint 3.2's own requirement. A failure to apply this
      // write means Magica may have already started a billable run we
      // can no longer track; never start a second one because of it.
      const persisted = await persistProviderRunId(context.invocationId, started.runId);
      if (!persisted.applied) {
        console.error("Magica run started but its id could not be recorded", {
          invocationId: context.invocationId,
          agentRunId: context.agentRunId,
        });
        throw new ProviderOutcomeUnknownError(name, "MAGICA_RUN_ID_NOT_PERSISTED");
      }

      // From here the job is Magica's: tell the UI we are waiting for it.
      // Best-effort: never let a progress report affect a started billable run.
      await context.onProgress?.("provider_waiting").catch(() => undefined);

      const outcome = await pollMagicaRunToCompletion({
        agentRunId: context.agentRunId,
        providerRunId: started.runId,
        waitFn,
      });
      if (outcome.status === "failed") {
        // Same message/semantics as before; also carries Magica's reported usage.
        throw new ProviderRunFailedError(outcome.errorMessage, outcome.creditUsed);
      }
      const normalized = normalizeMagicaOutput(name, outcome.output, outcome.creditUsed);
      // M2: "completed" without valid media is a failure the user can see — not
      // an empty success. Magica's reported usage is kept, as for any failed run.
      if (!normalized.images) {
        throw new ProviderRunFailedError(outputInvalidMessage(name), outcome.creditUsed, PROVIDER_OUTPUT_INVALID);
      }
      return normalized;
    },
    async reconcile(invocation, options) {
      const outcome = await reconcileMagicaRun(invocation, waitFn, options);
      if (outcome.status === "completed") {
        const normalized = normalizeMagicaOutput(name, outcome.output, outcome.creditUsed);
        if (!normalized.images) {
          return {
            status: "failed" as const,
            errorCode: PROVIDER_OUTPUT_INVALID,
            errorMessage: outputInvalidMessage(name),
            ...(outcome.creditUsed !== undefined ? { creditUsed: outcome.creditUsed } : {}),
          };
        }
        return { status: "completed" as const, output: normalized };
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

// ---------- Admission policies (see project-docs/magica/CREDIT_ACCOUNTING.md) ----------

/** Crop Image is a documented flat price; `/pricing` (fixed, 5000) and
 * `estimate-credits` (5000) agree, so no estimate call is needed. */
export const CROP_IMAGE_CREDITS = BigInt(5000);

/** GPT Image 2: Magica's own estimate, only for an explicit size. Size
 * "Auto" (or omitted, which defaults to Auto) is priced from the actual
 * output and cannot be estimated, so it is refused with guidance. The
 * estimate body mirrors the one previously verified to succeed; media
 * (uploadedImages) is never sent — it does not affect GPT Image 2 pricing. */
function gptImage2Admission(subModelId: string) {
  return (input: { prompt: string; size?: unknown; quality?: string; n?: number }): AdmissionSpec => {
    if (input.size === undefined || input.size === "Auto") {
      return {
        kind: "blocked",
        code: "EXPLICIT_SIZE_REQUIRED",
        message:
          'The cost of size "Auto" cannot be estimated before running. Retry with an explicit size such as "1024x1024".',
      };
    }
    const data: Record<string, unknown> = { prompt: input.prompt, size: input.size };
    if (input.quality !== undefined) data.quality = input.quality;
    if (input.n !== undefined) data.n = input.n;
    return { kind: "estimate", node: { type: "gpt_image_2", subModelId, data } };
  };
}

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
    admission: gptImage2Admission("gpt-image-2-text"),
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
    admission: gptImage2Admission("gpt-image-2-edit"),
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
    admission: () => ({ kind: "fixed", credits: CROP_IMAGE_CREDITS }),
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
      "Combine 2 to 100 of the user's own uploaded videos (5 minutes combined at most) into a single video, in the given order, with an optional transition between clips. Pass the video URLs exactly as listed under the user's attached files; generated videos and external links are not accepted.",
    nodeType: "merge_videos",
    inputSchema: MergeVideosInputSchema,
    // Decision 0018: priced from the server-measured durations of the user's
    // own uploads (no duration exists in Magica's input); settlement still
    // charges Magica's reported creditUsed.
    admission: async (input, context) => {
      const sources = await resolveMergeSources(context.userId, input.video_urls);
      const { required } = mergeAdmissionCredits(sources.videoCount, sources.totalSeconds);
      return { kind: "fixed", credits: required };
    },
  });
