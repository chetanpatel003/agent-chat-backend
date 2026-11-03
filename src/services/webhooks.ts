import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { NotFoundError, ValidationError } from "@/lib/errors";
import type { WebhookEndpoint } from "@/generated/prisma/client";
import {
  WebhookEventSchema,
  type CreateWebhookEndpointRequest,
  type CreatedWebhookEndpointResponse,
  type WebhookEndpointListResponse,
  type WebhookEndpointResponse,
  type WebhookEvent,
  type WebhookEventType,
} from "@/contracts/webhook";

// Signed outbound lifecycle webhooks. Signing follows the Standard Webhooks
// scheme: headers `webhook-id`, `webhook-timestamp`, `webhook-signature:
// v1,<base64 HMAC-SHA256(secret, "{id}.{timestamp}.{body}")>`. The event id
// is deterministic per lifecycle event, so retries and duplicate dispatches
// carry the same id and a consumer can drop repeats.

export const MAX_ENDPOINTS_PER_USER = 5;
export const DELIVERY_TIMEOUT_MS = 10_000;

function toResponse(row: WebhookEndpoint): WebhookEndpointResponse {
  return {
    id: row.id,
    url: row.url,
    events: row.events as WebhookEventType[],
    createdAt: row.createdAt.toISOString(),
    disabledAt: row.disabledAt?.toISOString() ?? null,
  };
}

/** Rejects obviously internal targets (SSRF). Hostname-literal check only. */
function assertPublicHttpsUrl(raw: string): void {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  const internal =
    url.protocol !== "https:" ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.startsWith("[") ||
    host === "0.0.0.0";
  if (internal) throw new ValidationError("Webhook URL must be a public https URL");
}

export async function createWebhookEndpoint(
  userId: string,
  input: CreateWebhookEndpointRequest,
): Promise<CreatedWebhookEndpointResponse> {
  assertPublicHttpsUrl(input.url);
  const active = await prisma.webhookEndpoint.count({ where: { userId, disabledAt: null } });
  if (active >= MAX_ENDPOINTS_PER_USER) {
    throw new ValidationError(`At most ${MAX_ENDPOINTS_PER_USER} active webhook endpoints`);
  }
  const secret = `whsec_${randomBytes(24).toString("base64url")}`;
  const row = await prisma.webhookEndpoint.create({
    data: { userId, url: input.url, events: [...new Set(input.events)], secret },
  });
  return { ...toResponse(row), secret };
}

export async function listWebhookEndpoints(userId: string): Promise<WebhookEndpointListResponse> {
  const rows = await prisma.webhookEndpoint.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
  return { items: rows.map(toResponse) };
}

/** Disables (never deletes) an endpoint; another user's id is a 404. Idempotent. */
export async function disableWebhookEndpoint(userId: string, endpointId: string): Promise<WebhookEndpointResponse> {
  const row = await prisma.webhookEndpoint.findFirst({ where: { id: endpointId, userId } });
  if (!row) throw new NotFoundError("Webhook endpoint not found");
  if (row.disabledAt) return toResponse(row);
  return toResponse(await prisma.webhookEndpoint.update({ where: { id: row.id }, data: { disabledAt: new Date() } }));
}

export function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
  return `v1,${createHmac("sha256", secret).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

/** For consumers (and tests): constant-time check, with a replay window. */
export function verifyWebhookSignature(
  secret: string,
  headers: { id: string; timestamp: string; signature: string },
  body: string,
  now = Date.now(),
  toleranceSeconds = 300,
): boolean {
  const timestamp = Number(headers.timestamp);
  if (!Number.isFinite(timestamp) || Math.abs(now / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = Buffer.from(signWebhook(secret, headers.id, timestamp, body));
  return headers.signature.split(" ").some((candidate) => {
    const given = Buffer.from(candidate);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

export type WebhookDispatcher = (endpointId: string, event: WebhookEvent) => Promise<void>;

export type WebhookNotifier = (
  type: WebhookEventType,
  data: { status: string; errorCode?: string | null; toolInvocationId?: string; toolName?: string },
) => Promise<void>;

/**
 * Loads the run owner's active endpoints once (one query per execution) and
 * returns a notifier that queues each lifecycle event for the endpoints
 * subscribed to it, or null when there are none (nothing else is queried).
 * Never throws: webhook delivery must not affect a run.
 */
export async function createWebhookNotifier(
  dispatch: WebhookDispatcher,
  run: { id: string; chatId: string; userId: string },
): Promise<WebhookNotifier | null> {
  let endpoints: { id: string; events: string[] }[];
  try {
    endpoints = await prisma.webhookEndpoint.findMany({
      where: { userId: run.userId, disabledAt: null },
      select: { id: true, events: true },
    });
  } catch (error) {
    console.error("Webhook endpoints unavailable; events not sent for this execution", {
      agentRunId: run.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  if (endpoints.length === 0) return null;
  return async (type, data) => {
    try {
      const event = WebhookEventSchema.parse({
        id: `evt_${type}_${data.toolInvocationId ?? run.id}`,
        type,
        createdAt: new Date().toISOString(),
        data: {
          runId: run.id,
          chatId: run.chatId,
          status: data.status,
          ...(data.errorCode ? { errorCode: data.errorCode } : {}),
          ...(data.toolInvocationId ? { toolInvocationId: data.toolInvocationId, toolName: data.toolName } : {}),
        },
      });
      for (const endpoint of endpoints) {
        if (endpoint.events.includes(type)) await dispatch(endpoint.id, event);
      }
    } catch (error) {
      console.error("Webhook emit failed", {
        agentRunId: run.id,
        type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

/** A delivery the receiver will never accept: retrying can't help. */
export class PermanentWebhookFailure extends Error {
  constructor(status: number) {
    super(`Webhook endpoint rejected the delivery (HTTP ${status})`);
    this.name = "PermanentWebhookFailure";
  }
}

export type DeliveryOutcome = "delivered" | "skipped_disabled" | "permanent_failure";

/**
 * One delivery attempt. 2xx → delivered. 408/429/5xx/network error → throws
 * (the durable task retries, bounded). Other 4xx → permanent, not retried.
 * A disabled or removed endpoint is skipped.
 */
export async function deliverWebhook(
  endpointId: string,
  event: WebhookEvent,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<DeliveryOutcome> {
  const endpoint = await prisma.webhookEndpoint.findUnique({ where: { id: endpointId } });
  if (!endpoint || endpoint.disabledAt) return "skipped_disabled";
  const body = JSON.stringify(event);
  const timestamp = Math.floor(now / 1000);
  const response = await fetchImpl(endpoint.url, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    headers: {
      "content-type": "application/json",
      "user-agent": "agent-chat-webhooks/1",
      "webhook-id": event.id,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": signWebhook(endpoint.secret, event.id, timestamp, body),
    },
    body,
  });
  if (response.ok) return "delivered";
  if (response.status === 408 || response.status === 429 || response.status >= 500) {
    throw new Error(`Webhook endpoint returned HTTP ${response.status}; will retry`);
  }
  console.warn("Webhook delivery permanently rejected", { endpointId, eventId: event.id, status: response.status });
  return "permanent_failure";
}
