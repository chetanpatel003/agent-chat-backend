---
name: image-editing
description: Guidance for planning and improving image edits — cropping, aspect ratio changes, and generative edits.
---

# Image editing

Use this skill when the user wants an existing image cropped, resized,
retouched, or otherwise generatively edited (background removal, object
replacement, style changes). It is planning guidance for *you*, not a
tool itself — the actual edit is performed by a separate tool call.

## Decide: crop/resize vs. generative edit

- If the request is purely geometric (cut to a shape, change aspect
  ratio, remove dead space at the edges, straighten a horizon) — this is
  a **crop**. No pixels are invented; only framing changes.
- If the request changes *content* (remove an object, change a
  background, alter color/style, add something that wasn't in the
  original) — this needs a **generative edit**. Say so explicitly to the
  user if they asked for "crop" but actually want object removal; a crop
  cannot do that.
- If the request is ambiguous ("make this photo better for Instagram"),
  ask one clarifying question about the target use (platform, aspect
  ratio, whether content changes are acceptable) before proceeding —
  don't guess at an aggressive generative edit when a simple crop would
  satisfy the actual need.

## Crop and framing checklist

1. **Preserve the subject.** Identify the primary subject before
   choosing crop bounds; never crop so tightly that part of a clearly
   central subject (a face, a product, a logo) is cut off unless the
   user explicitly asked for a tight/detail crop.
2. **Respect safe margins.** If the image will carry text overlays or be
   placed in a UI frame, leave margin — don't crop edge-to-edge on a
   subject that needs breathing room.
3. **Match the target aspect ratio deliberately.** Common targets: 1:1
   (square, avatars/thumbnails), 4:5 or 9:16 (vertical social), 16:9
   (video/banners), 3:2 or 4:3 (standard photo). Ask which platform if
   it isn't stated and it materially changes the right crop.
4. **Don't upscale to fill a crop.** A crop can only choose a region of
   the existing image; if the desired output is larger than the source
   supports at acceptable quality, say so rather than silently
   stretching.

See `guides/composition.md` for deeper composition guidance (rule of
thirds, leading lines, headroom) once you've confirmed crop vs.
generative edit.

## Generative edit checklist

1. **State what changes and what must stay the same.** A good
   generative-edit instruction separates "change this" from "keep
   everything else identical" — vague instructions produce
   unpredictable results.
2. **Flag irreversibility.** A generative edit replaces pixels; if the
   user might want the original back, make sure the UI/flow preserves
   it (this is a product-level concern to flag, not something this
   skill's guidance alone solves).
3. **Small, composable edits over one large one.** When a request bundles
   several distinct changes (remove background AND change the subject's
   shirt color AND crop to square), prefer sequencing them as separate,
   checkable steps rather than one compound instruction — easier to spot
   which part went wrong.

## Common pitfalls

- Treating "remove the background" as a crop — it isn't; it's a
  generative edit even though no framing changed.
- Choosing a crop that technically satisfies the aspect ratio but cuts
  through a face, a product's branding, or important text in the source
  image.
- Silently picking an aspect ratio when the user named a specific
  platform that has a well-known standard ratio — use the standard
  instead of guessing.
