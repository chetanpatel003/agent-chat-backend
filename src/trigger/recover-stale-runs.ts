import { schedules } from "@trigger.dev/sdk";
import { sweepStaleRuns, triggerRunStatus } from "@/services/stale-run-recovery";

export const STALE_RUN_RECOVERY_CRON = "*/5 * * * *";

export const recoverStaleRuns = schedules.task({
  id: "recover-stale-runs",
  cron: STALE_RUN_RECOVERY_CRON,
  // One sweep at a time; each recovery is a guarded compare-and-set anyway.
  queue: { concurrencyLimit: 1 },
  retry: { maxAttempts: 2, minTimeoutInMs: 5_000, maxTimeoutInMs: 30_000, factor: 2 },
  maxDuration: 300,
  run: () => sweepStaleRuns({ triggerRunStatus }),
});
