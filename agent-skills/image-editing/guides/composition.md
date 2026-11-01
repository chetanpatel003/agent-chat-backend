# Composition guidance

Supporting detail for the `image-editing` skill — read this when a crop
or reframe decision isn't obvious from the top-level checklist alone.

## Rule of thirds

Divide the frame into a 3x3 grid. Placing the main subject near one of
the four intersection points (rather than dead center) usually reads as
more natural for a landscape or portrait photo. Dead-center framing is
still correct for symmetric subjects, product shots on a plain
background, and most avatar/profile crops — don't apply the rule
mechanically where centered framing is the actual convention for that
use case.

## Leading lines and horizon

- A tilted horizon almost always needs straightening unless the tilt is
  clearly a deliberate stylistic choice in the source image.
- Roads, rivers, fences, and similar lines that lead toward the subject
  are worth preserving inside the crop, not cut off at the frame edge,
  when the crop has room to include them.

## Headroom and lead room

- **Headroom**: for a portrait, leave a little space above the head
  rather than cropping flush to the hairline — flush-to-the-top crops
  read as cramped.
- **Lead room**: if the subject is facing or moving toward one side of
  the frame, leave more space on that side than behind them. A subject
  facing hard into the crop edge reads as visually trapped.

## Platform aspect-ratio presets

| Use case | Ratio | Notes |
|---|---|---|
| Square thumbnail / avatar | 1:1 | Centered subject, generous margin |
| Vertical social (Stories/Reels/TikTok) | 9:16 | Keep key content in the middle ~80% — top/bottom are often covered by UI chrome |
| Portrait feed post | 4:5 | Slightly taller than square; most forgiving for a half/full-body subject |
| Landscape/banner | 16:9 | Wide; good for scenery, screenshots, video thumbnails |
| Standard photo print | 3:2 or 4:3 | Use when the destination is print, not a specific app |

When in doubt and the user named a specific app or platform, prefer that
platform's current standard ratio over any ratio in this table — apps
change their recommended sizes over time; treat this table as a
reasonable default, not an authority that overrides what the user
actually asked for.
