import { withRoute, routeOptions, parseJsonBody } from "@/lib/route-handler";
import { CreateWebhookEndpointRequestSchema } from "@/contracts/webhook";
import { createWebhookEndpoint, listWebhookEndpoints } from "@/services/webhooks";

export const OPTIONS = routeOptions;

/** The caller's webhook endpoints (secrets are never listed). */
export const GET = withRoute<Record<string, never>, unknown>(async ({ auth }) => listWebhookEndpoints(auth.userId));

/** Registers an endpoint; the signing secret is returned only in this response. */
export const POST = withRoute<Record<string, never>, unknown>(
  async ({ request, auth }) =>
    createWebhookEndpoint(auth.userId, await parseJsonBody(request, CreateWebhookEndpointRequestSchema)),
  { status: 201 },
);
