import { schedules } from "@trigger.dev/sdk";
import { sweepWaitpoints } from "@/services/waitpoint-recovery";
import { triggerWaitpointTokenClient } from "@/services/waitpoint";
import { cancelTriggerRunBestEffort } from "@/services/agent-run";

export const WAITPOINT_RECOVERY_CRON = "*/5 * * * *";

export const recoverWaitpoints = schedules.task({
  id: "recover-waitpoints",
  cron: WAITPOINT_RECOVERY_CRON,
  // One sweep at a time; every step is guarded/idempotent anyway.
  queue: { concurrencyLimit: 1 },
  retry: { maxAttempts: 2, minTimeoutInMs: 5_000, maxTimeoutInMs: 30_000, factor: 2 },
  maxDuration: 300,
  run: () => sweepWaitpoints({ client: triggerWaitpointTokenClient, cancelTriggerRun: cancelTriggerRunBestEffort }),
});
