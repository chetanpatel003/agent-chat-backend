import { prisma } from "@/lib/prisma";
import { generatedObjectKey, openSourceStream, putObjectStream, SourceFetchError, StorageConfigError } from "@/lib/b2";
import type { Attachment, Prisma } from "@/generated/prisma/client";

// Archives successful Magica outputs into private B2 as GENERATED
// attachments. Runs only after the ToolInvocation's COMPLETED outcome is
// persisted and never changes it: archival success/failure is recorded on
// the Attachment rows alone. Reads the stored output only — never calls
// Magica again.

const IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp"]);
const VIDEO_TYPES: ReadonlySet<string> = new Set(["video/mp4", "video/webm", "video/quicktime"]);
const MAX_BYTES = { image: 50 * 1024 * 1024, video: 500 * 1024 * 1024 } as const;
const MAX_OUTPUTS_PER_INVOCATION = 10;

type MediaFamily = "image" | "video";
export type GeneratedOutputs = { family: MediaFamily; urls: string[] };

/** The only tools whose outputs are archived. Others never touch storage or the DB here. */
const GENERATED_MEDIA_TOOLS: ReadonlySet<string> = new Set(["generate_image", "edit_image", "crop_image", "merge_videos"]);

export function isGeneratedMediaTool(toolName: string): boolean {
  return GENERATED_MEDIA_TOOLS.has(toolName);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string") ? value : null;
}

function single(value: unknown): string[] | null {
  return typeof value === "string" && value.length > 0 ? [value] : null;
}

/**
 * Tool-specific extraction from the persisted output `{ raw, images? }`.
 * generate_image: `raw.result[]` (live-verified). edit_image: same Magica
 * node, same shape (not live-run). crop_image / merge_videos: the
 * assessment-documented `image_url` / `video_url` (not live-run), or a
 * `result[]` if that is what arrives. Anything else yields nothing.
 */
export function extractGeneratedOutputs(toolName: string, output: unknown): GeneratedOutputs | null {
  const o = record(output);
  if (!o) return null;
  const raw = record(o.raw);
  let family: MediaFamily;
  let urls: string[] | null;
  switch (toolName) {
    case "generate_image":
    case "edit_image":
      family = "image";
      urls = strings(o.images) ?? strings(raw?.result);
      break;
    case "crop_image":
      family = "image";
      urls = single(raw?.image_url) ?? strings(o.images) ?? strings(raw?.result);
      break;
    case "merge_videos":
      family = "video";
      urls = single(raw?.video_url) ?? strings(o.images) ?? strings(raw?.result);
      break;
    default:
      return null;
  }
  return urls ? { family, urls: urls.slice(0, MAX_OUTPUTS_PER_INVOCATION) } : null;
}

/** Width/height for output `index` from Magica's `resultMetadata`, when present and sane. */
function metadataFor(output: unknown, index: number): Prisma.InputJsonValue {
  const resultMetadata = record(record(output)?.raw)?.resultMetadata;
  const meta = Array.isArray(resultMetadata) ? record(resultMetadata[index]) : null;
  const dim = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined);
  return Object.fromEntries(
    Object.entries({ width: dim(meta?.width), height: dim(meta?.height) }).filter(([, v]) => v !== undefined),
  );
}

class UnsupportedGeneratedMediaError extends Error {
  constructor() {
    super("Generated output is not a supported media type");
    this.name = "UnsupportedGeneratedMediaError";
  }
}

type ArchiveOutcome = "ready" | "permanent" | "transient";

/** Retrying cannot fix these: the source itself is unacceptable, or storage is
 * not configured. Everything else (timeouts, network, provider/B2 5xx, DB
 * errors, short reads) is treated as transient and retried with a bound. */
const PERMANENT_SOURCE_REASONS = new Set(["NOT_HTTPS", "HOST_NOT_ALLOWED", "PRIVATE_ADDRESS", "REDIRECT", "TOO_LARGE", "NO_LENGTH"]);

function isPermanent(error: unknown): boolean {
  if (error instanceof UnsupportedGeneratedMediaError || error instanceof StorageConfigError) return true;
  return error instanceof SourceFetchError && PERMANENT_SOURCE_REASONS.has(error.reason);
}

async function archiveOne(
  row: Attachment,
  ownerUserId: string,
  sourceUrl: string,
  family: MediaFamily,
  output: unknown,
): Promise<ArchiveOutcome> {
  if (!row.toolInvocationId) return "permanent";
  try {
    const source = await openSourceStream(sourceUrl, { maxBytes: MAX_BYTES[family] });
    const mimeType = (source.contentType ?? "").split(";")[0].trim().toLowerCase();
    if (!(family === "image" ? IMAGE_TYPES : VIDEO_TYPES).has(mimeType)) {
      source.body.destroy();
      throw new UnsupportedGeneratedMediaError();
    }
    const key = generatedObjectKey(ownerUserId, row.toolInvocationId, row.order, mimeType);
    await putObjectStream({ key, body: source.body, contentLength: source.contentLength, contentType: mimeType });
    // Guarded: a concurrent archiver that already finished wins; this is a no-op.
    await prisma.attachment.updateMany({
      where: { id: row.id, status: { not: "READY" } },
      data: {
        status: "READY",
        storageKey: key,
        mimeType,
        sizeBytes: BigInt(source.contentLength),
        sanitizedMetadata: metadataFor(output, row.order),
      },
    });
    return "ready";
  } catch (error) {
    const permanent = isPermanent(error);
    console.error("Generated asset archival failed", {
      attachmentId: row.id,
      toolInvocationId: row.toolInvocationId,
      error: error instanceof Error ? error.name : "UnknownError",
      reason: error instanceof SourceFetchError ? error.reason : undefined,
      permanent,
    });
    // Never downgrade a READY row written by a concurrent archiver.
    await prisma.attachment
      .updateMany({ where: { id: row.id, status: { in: ["PROCESSING", "FAILED"] } }, data: { status: "FAILED" } })
      .catch(() => undefined);
    return permanent ? "permanent" : "transient";
  }
}

export type ArchivalSummary = {
  /** Outputs the invocation produced that this module can archive. */
  outputs: number;
  ready: number;
  permanentFailures: number;
  transientFailures: number;
};

const EMPTY_SUMMARY: ArchivalSummary = { outputs: 0, ready: 0, permanentFailures: 0, transientFailures: 0 };

/**
 * Archives every supported output of one COMPLETED invocation, in output
 * order. Idempotent: rows are keyed by (toolInvocationId, order), READY
 * rows are skipped, and re-copies overwrite the same deterministic key.
 * Rows left FAILED or PROCESSING (e.g. by a crash) are retried. Never
 * throws — archival must not affect the tool's own outcome; the returned
 * summary tells a caller (the archival task) whether retrying can help.
 */
export async function archiveInvocationOutputs(toolInvocationId: string): Promise<ArchivalSummary> {
  try {
    const invocation = await prisma.toolInvocation.findUnique({
      where: { id: toolInvocationId },
      include: { agentRun: { select: { userId: true, chatId: true } } },
    });
    if (!invocation || invocation.status !== "COMPLETED" || !invocation.messageId) return EMPTY_SUMMARY;
    const outputs = extractGeneratedOutputs(invocation.toolName, invocation.output);
    if (!outputs) return EMPTY_SUMMARY;

    const { userId, chatId } = invocation.agentRun;
    await prisma.attachment.createMany({
      data: outputs.urls.map((_, order) => ({
        userId,
        chatId,
        messageId: invocation.messageId,
        toolInvocationId,
        source: "GENERATED" as const,
        status: "PROCESSING" as const,
        mimeType: "application/octet-stream", // replaced by the verified type on READY
        order,
      })),
      skipDuplicates: true,
    });
    const pending = await prisma.attachment.findMany({
      where: { toolInvocationId, status: { not: "READY" } },
      orderBy: { order: "asc" },
    });
    const summary: ArchivalSummary = {
      ...EMPTY_SUMMARY,
      outputs: outputs.urls.length,
      ready: outputs.urls.length - pending.length,
    };
    for (const row of pending) {
      const sourceUrl = outputs.urls[row.order];
      const outcome = sourceUrl
        ? await archiveOne(row, userId, sourceUrl, outputs.family, invocation.output)
        : "permanent";
      if (outcome === "ready") summary.ready++;
      else if (outcome === "permanent") summary.permanentFailures++;
      else summary.transientFailures++;
    }
    return summary;
  } catch (error) {
    // DB unavailable or similar: nothing was decided, so retrying may help.
    console.error("Generated asset archival could not run", {
      toolInvocationId,
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return { ...EMPTY_SUMMARY, transientFailures: 1 };
  }
}

/** Recovery: archives outputs of every COMPLETED invocation in a run
 * (e.g. after a crash between the provider result and archival). */
export async function archiveRunGeneratedAssets(agentRunId: string): Promise<void> {
  const invocations = await prisma.toolInvocation
    .findMany({
      where: { agentRunId, status: "COMPLETED", toolName: { in: [...GENERATED_MEDIA_TOOLS] } },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    })
    .catch(() => []);
  for (const { id } of invocations) await archiveInvocationOutputs(id);
}
