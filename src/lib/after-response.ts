import { after } from "next/server";

/**
 * Schedules best-effort work to run after the HTTP response has been sent
 * (Next.js `after()`; on Vercel the function stays alive until it settles).
 *
 * - The caller never waits: this returns immediately, before any of `task`'s
 *   database queries or provider calls start.
 * - `task` failures are logged and swallowed — they can never reach the
 *   response or the work already done for it.
 * - Outside a request scope (scripts, tests) `after()` throws; the work is then
 *   skipped (logged), never run synchronously in its place.
 */
export function runAfterResponse(label: string, task: () => Promise<void>): void {
  const guarded = async () => {
    try {
      await task();
    } catch (error) {
      console.error("Deferred work failed", { label, error: error instanceof Error ? error.name : "UnknownError" });
    }
  };
  try {
    after(guarded);
  } catch (error) {
    console.warn("Deferred work skipped: no request scope", { label, error: error instanceof Error ? error.name : "UnknownError" });
  }
}
