// The one canonical extraction of media URLs from a Magica run's raw output,
// shared by tool persistence (normalised `images`), generated-asset archival
// and — via the persisted `images` field — the chat UI.
//
// Field candidates per tool, in priority order:
//   generate_image / edit_image: result[] (live-verified), images[]
//   crop_image:                  image_url (documented), result[], images[]
//   merge_videos:                video_url (documented), result[], images[]
// Only absolute https URLs are kept; order is preserved. Anything else
// yields an empty list, which callers must treat as "no usable output".

const MAX_URLS = 10;

const CANDIDATES: Record<string, readonly { field: string; kind: "single" | "array" }[]> = {
  generate_image: [
    { field: "result", kind: "array" },
    { field: "images", kind: "array" },
  ],
  edit_image: [
    { field: "result", kind: "array" },
    { field: "images", kind: "array" },
  ],
  crop_image: [
    { field: "image_url", kind: "single" },
    { field: "result", kind: "array" },
    { field: "images", kind: "array" },
  ],
  merge_videos: [
    { field: "video_url", kind: "single" },
    { field: "result", kind: "array" },
    { field: "images", kind: "array" },
  ],
};

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** Media URLs from a raw Magica output for `toolName`; [] when none is valid or recognised. */
export function extractMagicaMediaUrls(toolName: string, raw: unknown): string[] {
  const candidates = CANDIDATES[toolName];
  if (!candidates || !raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const record = raw as Record<string, unknown>;
  for (const { field, kind } of candidates) {
    const value = record[field];
    const values = kind === "single" ? [value] : Array.isArray(value) ? value : [];
    const urls = values.filter(isHttpsUrl).slice(0, MAX_URLS);
    if (urls.length > 0) return urls;
  }
  return [];
}
