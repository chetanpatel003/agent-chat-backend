// Merge Videos credit admission (decision 0018).
//
// Magica prices a merge per billable minute of output:
//   rate(n) = 40,000 + 10,000 × (n − 1) credits/minute   (n = video_urls.length)
// and its input has no duration field, so the cost is estimated from the
// server-measured durations of the source videos — their sum is an upper
// bound on the output (transitions can only shorten it). A merge is
// admitted only when every source is the user's own READY uploaded video
// with a measured duration; otherwise it fails before any provider call
// (Magica: "missing duration measurement fails rather than charging the
// example"). Admission only checks the balance — settlement still charges
// Magica's reported creditUsed, exactly as for every other billable tool.

import { prisma } from "@/lib/prisma";
import { storageKeyFromUrl } from "@/lib/b2";
import { AttachmentMetadataSchema } from "@/contracts/attachment";
import { ToolExecutionError } from "@/tools/types";

export const MERGE_BASE_CREDITS_PER_MINUTE = 40_000;
export const MERGE_ADDITIONAL_VIDEO_CREDITS_PER_MINUTE = 10_000;
/** D3: combined source duration cap, seconds. */
export const MERGE_MAX_TOTAL_SECONDS = 300;
/** D1: safety multiplier 1.3, as an exact fraction (GPT Image 2 was billed at exactly 1.3× its /pricing tier). */
const SAFETY_NUMERATOR = BigInt(13);
const SAFETY_DENOMINATOR = BigInt(10);

/** Credits per minute for a merge of `videoCount` videos. */
export function mergeRatePerMinute(videoCount: number): number {
  return MERGE_BASE_CREDITS_PER_MINUTE + MERGE_ADDITIONAL_VIDEO_CREDITS_PER_MINUTE * Math.max(0, videoCount - 1);
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - BigInt(1)) / b;

/**
 * Conservative admission estimate, exact integer arithmetic:
 *   base     = ceil(rate(n) × S / 60)   (S prorated to the millisecond, never rounded up to minutes)
 *   required = ceil(base × 1.3)
 */
export function mergeAdmissionCredits(videoCount: number, totalSeconds: number): { base: bigint; required: bigint } {
  const rate = BigInt(mergeRatePerMinute(videoCount));
  const millis = BigInt(Math.ceil(totalSeconds * 1000 - 1e-6)); // tolerate float noise, never under-count
  const base = ceilDiv(rate * millis, BigInt(60_000));
  return { base, required: ceilDiv(base * SAFETY_NUMERATOR, SAFETY_DENOMINATOR) };
}

export type MergeSources = { videoCount: number; totalSeconds: number };

/**
 * Maps each `video_urls` entry (in order; duplicates count separately) to
 * one of `userId`'s own uploaded videos and sums their server-measured
 * durations. Accepts our own B2 URLs (any signature — ownership comes from
 * the attachment row, never the URL) and, for an upload not archived yet,
 * its exact stored Transloadit URL. Throws a coded ToolExecutionError.
 */
export async function resolveMergeSources(userId: string, videoUrls: string[]): Promise<MergeSources> {
  const keys = new Map(videoUrls.map((url) => [url, storageKeyFromUrl(url)]));
  const storageKeys = [...new Set([...keys.values()].filter((k): k is string => k !== null))];
  const rawUrls = [...new Set(videoUrls.filter((url) => keys.get(url) === null))];

  const rows =
    storageKeys.length === 0 && rawUrls.length === 0
      ? []
      : await prisma.attachment.findMany({
          where: {
            userId,
            OR: [
              ...(storageKeys.length ? [{ storageKey: { in: storageKeys } }] : []),
              ...(rawUrls.length ? [{ url: { in: rawUrls }, storageKey: null }] : []),
            ],
          },
          select: { storageKey: true, url: true, source: true, status: true, mimeType: true, sanitizedMetadata: true },
        });

  const unsupported = () =>
    new ToolExecutionError(
      "MERGE_SOURCE_UNSUPPORTED",
      "Merge Videos only accepts videos you uploaded (attach them, or pick them from your media library). Generated videos and external links can't be merged.",
    );

  const durations: number[] = [];
  for (const url of videoUrls) {
    const key = keys.get(url);
    const row = rows.find((r) => (key ? r.storageKey === key : r.storageKey === null && r.url === url));
    if (!row || row.source !== "UPLOAD" || row.status !== "READY" || !row.mimeType.startsWith("video/")) throw unsupported();
    const metadata = AttachmentMetadataSchema.safeParse(row.sanitizedMetadata);
    const seconds = metadata.success ? metadata.data.durationSeconds : undefined;
    if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
      throw new ToolExecutionError(
        "MERGE_DURATION_UNKNOWN",
        "The length of one of these videos is unknown, so the cost of merging can't be estimated. Re-upload the video and try again.",
      );
    }
    durations.push(seconds);
  }

  const totalSeconds = durations.reduce((sum, s) => sum + s, 0);
  if (totalSeconds > MERGE_MAX_TOTAL_SECONDS) {
    throw new ToolExecutionError(
      "MERGE_DURATION_LIMIT",
      `These videos are ${Math.ceil(totalSeconds)} seconds long in total; merges are limited to ${MERGE_MAX_TOTAL_SECONDS} seconds (5 minutes).`,
    );
  }
  return { videoCount: videoUrls.length, totalSeconds };
}
