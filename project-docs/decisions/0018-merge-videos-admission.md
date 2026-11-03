# 0018 — Merge Videos credit admission

Status: **accepted** (2026-11-03). Supersedes the open version of this record, which proposed
rounding up to whole minutes — Magica's own pricing record says partial minutes are prorated.

## Evidence (no live merge has been run; D2 not approved)
- Magica `/pricing` for `merge_videos` (saved during discovery; `project-docs/magica/CREDIT_ESTIMATION.md`):
  `per_minute`, base 40,000 + 10,000 per additional video (`max(0, n − 1)`) per billable minute;
  billing basis "measured output duration in seconds / 60", "partial minutes are prorated", "floor
  whole credits after prorating"; "summed source duration is a conservative reservation because
  transitions can shorten output"; "missing duration measurement fails rather than charging the example".
- The merge input has no duration field, so `estimate-credits` can't price a real merge (it
  returned 50,000 for an empty design-time form — unexplained vs. the 40,000 example).
- GPT Image 2's real `creditUsed` was exactly 1.3× its `/pricing` tier; crop's matched 1.0×.
- **Transloadit duration (D4, one approved upload, 2026-11-03):** a 3.0 s, 160×120 synthetic H.264
  MP4 (2,876 bytes) uploaded through the app's normal flow; the server-side Assembly re-read by
  `completeUpload` gave `meta.duration`, persisted as `durationSeconds: 3` (ground truth 3.0 s via
  AVFoundation), plus width/height, READY, archived to B2. Free Community plan; no retries.

## Policy
A merge is admitted only when every `video_urls` entry maps to the caller's own `READY`
**uploaded** video (`source = UPLOAD`, `video/*`) — by storage key from our own B2 URL (ownership
from the attachment row, never the URL or its signature) or, for an upload not yet archived, its
exact stored Transloadit URL — with a server-measured `durationSeconds > 0`. Duplicates count
separately. Client-supplied durations are never used.

For n videos and combined source duration S seconds (prorated to the millisecond):

```
rate(n)  = 40,000 + 10,000 × (n − 1)          credits / minute
base     = ceil(rate(n) × S / 60)
required = ceil(base × 1.3)                    (D1 safety multiplier)
```
S ≤ 300 s (D3). Admission requires `balance ≥ required` (existing fixed-amount check; no reservation).

| Condition | Code |
|---|---|
| External URL, generated video (D5), another user's file, non-READY, non-video, unknown URL | `MERGE_SOURCE_UNSUPPORTED` |
| Duration missing, zero, negative or not a number | `MERGE_DURATION_UNKNOWN` |
| S > 300 s | `MERGE_DURATION_LIMIT` |
| Balance below `required` | `INSUFFICIENT_CREDITS` |

All are refused before any Magica call. Settlement is unchanged: Magica's reported `creditUsed`,
capped at the balance, shortfall recorded, exactly once. The estimate is never charged.

## Not verified
- No live merge (D2 not approved): whether `creditUsed` follows the formula, which multiplier
  applies (1.0 / 1.25 / 1.3), and the poll output shape for merges are unconfirmed. If the real
  multiplier exceeds 1.3, an admitted merge may cost more than the estimate; settlement still
  charges the actual amount, capped at the balance (shortfall recorded).
- Duration precision for non-integer clip lengths (the one test clip was exactly 3 s).

Implementation: `src/services/merge-admission.ts`, `src/tools/magica-tools.ts` (admission hook now
receives the execution context and may be async), `src/lib/b2.ts#storageKeyFromUrl`.
