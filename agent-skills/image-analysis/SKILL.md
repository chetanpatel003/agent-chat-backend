---
name: image-analysis
description: Guidance for describing and analyzing an image's content, composition, and quality before acting on it.
---

# Image analysis

Use this skill when the user wants an image described, analyzed, or
checked for quality/problems — or as a first step before an edit, when
you need to understand what's actually in the image before planning a
crop or generative change.

## Structure a useful analysis

Cover, in order, only the parts relevant to what the user actually
asked:

1. **Subject.** What/who is the main subject, and where it sits in the
   frame.
2. **Composition.** Framing, symmetry/rule-of-thirds, cropping already
   present, anything cut off at the edges that looks unintentional.
3. **Lighting and color.** Overall exposure (over/underexposed), color
   cast, contrast; note it only when it's notable, not as a rote field
   to always fill in.
4. **Quality issues.** Blur (motion or focus), compression artifacts,
   low resolution relative to likely intended use, noise in low light.
5. **Anything that blocks the user's actual goal.** If they asked for an
   edit and the source image can't reasonably support it (too low-
   resolution to crop tighter without visible quality loss, a watermark
   that would be preserved by cropping around it, etc.), say so before
   recommending an approach.

Don't produce all five sections every time — a user asking "what's in
this photo" wants (1) and maybe (2); a user asking "is this good enough
to print large" wants (3) and (4) foregrounded.

## Flag quality problems before suggesting edits

If an image has a real quality problem (significant blur, very low
resolution, heavy compression artifacts), say so plainly before
proposing a crop or generative edit built on top of it — editing a bad
source produces a bad result, and the user should know that going in
rather than being surprised by the output.

## Ask before assuming intent

"Analyze this image" can mean "describe it for alt text," "tell me if
it's good enough for X," or "tell me what's wrong with it." If the
user's goal isn't already clear from context, ask briefly rather than
producing a generic five-paragraph description that may answer the
wrong question.

## Common pitfalls

- Describing every technical dimension exhaustively when the user only
  wanted a quick read of what's in the photo.
- Not flagging an obvious quality problem (severe blur, very low
  resolution) before it becomes relevant three steps later in an edit
  the user is about to request.
- Treating "analyze" as license to also perform an edit — analysis is
  descriptive; act on the image only if the user separately asks for a
  change.
