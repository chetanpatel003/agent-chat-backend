import { schedules } from "@trigger.dev/sdk";
import { PRODUCTION_RECOVERY_REGISTRY, sweepBillableInvocations } from "@/services/billable-recovery";
import { dispatchCreditSettlement } from "./settle-tool-credits";
import { dispatchGeneratedAssetArchival } from "./archive-generated-assets";

/** Every 10 minutes (matches RECOVERY_SWEEP_INTERVAL_MS). */
export const RECOVERY_CRON = "*/10 * * * *";

export const recoverBillableInvocations = schedules.task({
  id: "recover-billable-invocations",
  cron: RECOVERY_CRON,
  // One sweep at a time; a late run never overlaps the next.
  queue: { concurrencyLimit: 1 },
  // The next scheduled sweep is the real retry; one extra attempt covers a blip.
  retry: { maxAttempts: 2, minTimeoutInMs: 5_000, maxTimeoutInMs: 30_000, factor: 2 },
  maxDuration: 600,
  run: () =>
    sweepBillableInvocations({
      registry: PRODUCTION_RECOVERY_REGISTRY,
      dispatchSettlement: dispatchCreditSettlement,
      dispatchArchival: dispatchGeneratedAssetArchival,
    }),
});
