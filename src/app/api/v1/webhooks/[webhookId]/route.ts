import { withRoute, routeOptions } from "@/lib/route-handler";
import { disableWebhookEndpoint } from "@/services/webhooks";

export const OPTIONS = routeOptions;

/** Disables the endpoint (no further deliveries). Idempotent. */
export const DELETE = withRoute<{ webhookId: string }, unknown>(async ({ auth, params }) =>
  disableWebhookEndpoint(auth.userId, params.webhookId),
);
