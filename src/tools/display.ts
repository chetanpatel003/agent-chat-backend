import type { ToolDisplay } from "@/contracts/run-event";

/**
 * User-facing names and activity labels for every tool: the one place a
 * tool's status wording lives. Tool definitions reference their entry
 * (`display`), the agent turn publishes it with `tool_started`, and the
 * messages API adds the name to persisted `tool_use` blocks, so live
 * status and history after a refresh read the same. Labels only — never
 * inputs, outputs or model text.
 *
 * `activity` is what the tool itself is doing once the request has been
 * handed over (e.g. the provider accepted the job): "{activity}…".
 */
export const TOOL_DISPLAY = {
  generate_image: { name: "GPT Image 2", activity: "Generating image with Magica" },
  edit_image: { name: "GPT Image 2 edit", activity: "Editing image with Magica" },
  crop_image: { name: "Crop Image", activity: "Cropping image with Magica" },
  merge_videos: { name: "Merge Videos", activity: "Merging videos with Magica" },
  load_skill: { name: "Skill loader", activity: "Loading skill" },
  read_skill_asset: { name: "Skill guide", activity: "Reading skill guide" },
} as const satisfies Record<string, ToolDisplay>;

/** A tool's display, or a neutral one derived from its name (fixtures, unknown tools). */
export function toolDisplay(toolName: string, own?: ToolDisplay): ToolDisplay {
  if (own) return own;
  const known = (TOOL_DISPLAY as Record<string, ToolDisplay | undefined>)[toolName];
  if (known) return known;
  const words = toolName.replace(/[_-]+/g, " ").trim() || "tool";
  return { name: words.charAt(0).toUpperCase() + words.slice(1), activity: `Running ${words}` };
}
