---
name: video-editing
description: Guidance for planning video edits — merging/sequencing multiple clips into one output.
---

# Video editing

Use this skill when the user wants multiple video clips combined into a
single output. This is planning guidance for *you*, not the merge tool
itself — your job is to resolve ambiguity and produce a clean, explicit
plan before any merge is attempted.

## Resolve ordering before anything else

A merge is only as correct as its ordering, and ordering is the single
most common source of a wrong result:

1. If the user gave an explicit order ("intro, then the product demo,
   then the outro"), use it exactly — don't infer a "better" order.
2. If the user uploaded clips without stating an order, **ask** rather
   than guessing from upload order or filename — upload order is
   frequently incidental, not intentional.
3. If clip names clearly imply sequence (`clip_01`, `clip_02`, ...),
   confirm that reading with the user once rather than silently
   committing to it, unless they've already confirmed it in this
   conversation.

## Consistency checklist across clips

- **Resolution/aspect ratio.** Clips with mismatched resolution or
  aspect ratio need a stated normalization strategy (letterbox, crop-to-
  fill, or scale) — don't let the merge tool pick silently; state which
  approach applies and why, since each changes what's visible.
- **Frame rate.** Mixed frame rates can produce stutter at the join
  points; flag it if source clips clearly differ rather than assuming
  the merge step handles it invisibly.
- **Audio continuity.** If some clips have audio and others don't,
  decide (and say) whether silence is acceptable during the silent
  clips or whether background audio should carry through — don't leave
  this undecided and let the result surprise the user.
- **Transitions.** Default to a hard cut unless the user asks for
  something else (crossfade, fade-to-black). A hard cut is predictable;
  an unrequested transition style is an uninvited creative choice.

## Duration and scope sanity checks

- Confirm roughly how long the combined output will be if it matters for
  the user's stated purpose (a 90-second clip for a platform with a
  60-second limit is a real problem to flag before merging, not after).
- If a clip is extremely short (under ~1 second) or silent/black for its
  whole duration, flag it — it's often an accidental export rather than
  intended content.

## Common pitfalls

- Merging in upload order without confirming that's the intended
  sequence.
- Ignoring a resolution/aspect-ratio mismatch and letting the result
  silently letterbox or crop in an unintended way.
- Adding a transition style the user never asked for.
- Not mentioning a likely duration/platform-limit conflict before
  running the merge.
