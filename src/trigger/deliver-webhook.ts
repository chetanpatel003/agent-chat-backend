import { task } from "@trigger.dev/sdk";
import { deliverWebhook, type WebhookDispatcher } from "@/services/webhooks";
import type { WebhookEvent } from "@/contracts/webhook";

type DeliverWebhookPayload = { endpointId: string; event: WebhookEvent };

/** One delivery per (event, endpoint), retried with bounded backoff. */
export const deliverWebhookTask = task({
  id: "deliver-webhook",
  retry: { maxAttempts: 6, minTimeoutInMs: 5_000, maxTimeoutInMs: 10 * 60_000, factor: 3 },
  maxDuration: 60,
  run: (payload: DeliverWebhookPayload) => deliverWebhook(payload.endpointId, payload.event),
});

/**
 * Production dispatcher. The idempotency key is per (event, endpoint), so a
 * re-emitted event (e.g. after a worker retry) never queues a second delivery.
 * Never throws: a failed dispatch is logged and the run continues.
 */
export const dispatchWebhook: WebhookDispatcher = async (endpointId, event) => {
  try {
    await deliverWebhookTask.trigger(
      { endpointId, event },
      { idempotencyKey: `webhook:${event.id}:${endpointId}`, idempotencyKeyTTL: "7d" },
    );
  } catch (error) {
    console.error("Webhook dispatch failed", {
      endpointId,
      eventId: event.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
