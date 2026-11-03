// Generates mintlify/openapi.json from the application's Zod contracts, so the
// published API reference is the same schema the routes validate with.
// Run: pnpm tsx scripts/generate-openapi.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  AgentRunResponseSchema,
  AttachmentResponseSchema,
  AuthenticatedUserResponseSchema,
  ChatListResponseSchema,
  ChatResponseSchema,
  CompleteAttachmentRequestSchema,
  CompletionRequestSchema,
  CompletionResponseSchema,
  CreateAttachmentRequestSchema,
  CreateChatRequestSchema,
  CreateWebhookEndpointRequestSchema,
  CreatedWebhookEndpointResponseSchema,
  CreditBalanceResponseSchema,
  MediaLibraryPageSchema,
  PaginatedCreditLedgerResponseSchema,
  PaginatedMessageResponseSchema,
  RealtimeTokenResponseSchema,
  SendMessageRequestSchema,
  SendMessageResponseSchema,
  ToolRunRequestSchema,
  UpdateChatRequestSchema,
  UploadAuthorizationResponseSchema,
  WaitpointListResponseSchema,
  WaitpointResponseSchema,
  WebhookEndpointListResponseSchema,
  WebhookEndpointResponseSchema,
  WebhookEventSchema,
} from "../src/contracts";

type Op = {
  method: "get" | "post" | "patch" | "delete";
  path: string;
  tag: string;
  summary: string;
  description?: string;
  request?: z.ZodType;
  response?: z.ZodType;
  status?: number;
  idempotent?: boolean;
  query?: { name: string; description: string; schema: Record<string, unknown> }[];
};

const schema = (s: z.ZodType, io: "input" | "output") => z.toJSONSchema(s, { io, unrepresentable: "any" });
const envelope = (data: z.ZodType | null) => ({
  type: "object",
  required: ["ok", "data"],
  properties: { ok: { const: true }, data: data ? schema(data, "output") : { type: "null" } },
});
const page = [
  { name: "cursor", description: "Opaque cursor from a previous page.", schema: { type: "string" } },
  { name: "limit", description: "Page size (1–100, default 20).", schema: { type: "integer", minimum: 1, maximum: 100 } },
];

const ops: Op[] = [
  { method: "get", path: "/api/health", tag: "System", summary: "Health check" },
  { method: "get", path: "/api/v1/me", tag: "Account", summary: "Current user", response: AuthenticatedUserResponseSchema },
  { method: "post", path: "/api/v1/completions", tag: "Conversations", summary: "Chat-style completion", description: "Submits a user turn (new chat when `chatId` is omitted) and returns the run to follow. The agent runs asynchronously: poll the run, use realtime, or receive webhooks.", request: CompletionRequestSchema, response: CompletionResponseSchema, status: 202, idempotent: true },
  { method: "get", path: "/api/v1/chats", tag: "Conversations", summary: "List chats", response: ChatListResponseSchema, query: [...page, { name: "q", description: "Title search.", schema: { type: "string" } }] },
  { method: "post", path: "/api/v1/chats", tag: "Conversations", summary: "Create chat", request: CreateChatRequestSchema, response: ChatResponseSchema, status: 201 },
  { method: "get", path: "/api/v1/chats/{chatId}", tag: "Conversations", summary: "Get chat", response: ChatResponseSchema },
  { method: "patch", path: "/api/v1/chats/{chatId}", tag: "Conversations", summary: "Rename or pin chat", request: UpdateChatRequestSchema, response: ChatResponseSchema },
  { method: "delete", path: "/api/v1/chats/{chatId}", tag: "Conversations", summary: "Delete chat (soft)" },
  { method: "get", path: "/api/v1/chats/{chatId}/messages", tag: "Conversations", summary: "Read messages", description: "Newest page first; `items` are chronological. Page backwards with `olderCursor`.", response: PaginatedMessageResponseSchema, query: page },
  { method: "post", path: "/api/v1/chats/{chatId}/messages", tag: "Conversations", summary: "Submit message (starts a run)", description: "Admits the message and dispatches a durable agent run. `attachmentIds` mixes new uploads and media-library items, in order. `interruptRunId` cancels the active run atomically. One active run per chat (409 otherwise).", request: SendMessageRequestSchema, response: SendMessageResponseSchema, status: 202, idempotent: true },
  { method: "post", path: "/api/v1/chats/{chatId}/tool-runs", tag: "Tools", summary: "Run a Magica tool directly", description: "Runs one media tool without the model, as a run of the chat: the input is validated against the tool's schema, credits are admitted and settled exactly as for agent-requested calls, and the result arrives as an assistant message (tool_use + tool_result). Poll the returned run. merge_videos accepts only the caller's own uploaded videos with a measured duration (≤ 300 s combined), estimated as ceil(ceil((40,000 + 10,000 × (n − 1)) × seconds / 60) × 1.3) credits; refusals: MERGE_SOURCE_UNSUPPORTED, MERGE_DURATION_UNKNOWN, MERGE_DURATION_LIMIT, INSUFFICIENT_CREDITS.", request: ToolRunRequestSchema, response: SendMessageResponseSchema, status: 202, idempotent: true },
  { method: "get", path: "/api/v1/chats/{chatId}/runs/active", tag: "Runs", summary: "Active run", description: "`data` is null when nothing is running.", response: AgentRunResponseSchema },
  { method: "get", path: "/api/v1/chats/{chatId}/runs/{runId}", tag: "Runs", summary: "Run status", response: AgentRunResponseSchema },
  { method: "post", path: "/api/v1/chats/{chatId}/runs/{runId}/cancel", tag: "Runs", summary: "Stop run", description: "Idempotent. Partial output is kept.", response: AgentRunResponseSchema },
  { method: "get", path: "/api/v1/chats/{chatId}/runs/{runId}/realtime-token", tag: "Runs", summary: "Realtime token", description: "Short-lived, read-only Trigger.dev token scoped to this run (metadata events + `assistant-text` stream).", response: RealtimeTokenResponseSchema },
  { method: "get", path: "/api/v1/chats/{chatId}/runs/{runId}/waitpoints", tag: "Approvals", summary: "List waitpoints", response: WaitpointListResponseSchema },
  { method: "post", path: "/api/v1/chats/{chatId}/runs/{runId}/waitpoints/{waitpointId}/resolve", tag: "Approvals", summary: "Approve or reject a plan", description: "First decision wins; repeats are safe. 409 when expired, cancelled or the execution has ended; 503 (retryable) when the execution's state can't be confirmed.", request: z.object({ decision: z.enum(["approve", "reject"]), note: z.string().max(2000).optional() }), response: WaitpointResponseSchema },
  { method: "post", path: "/api/v1/attachments", tag: "Media", summary: "Create upload", request: CreateAttachmentRequestSchema, response: AttachmentResponseSchema, status: 201 },
  { method: "post", path: "/api/v1/attachments/{attachmentId}/upload-authorization", tag: "Media", summary: "Signed Transloadit parameters", response: UploadAuthorizationResponseSchema },
  { method: "post", path: "/api/v1/attachments/{attachmentId}/complete", tag: "Media", summary: "Complete upload", description: "Verifies the Assembly server-side and archives the file to B2 before READY.", request: CompleteAttachmentRequestSchema, response: AttachmentResponseSchema },
  { method: "post", path: "/api/v1/attachments/{attachmentId}/cancel", tag: "Media", summary: "Cancel upload", response: AttachmentResponseSchema },
  { method: "get", path: "/api/v1/attachments/library", tag: "Media", summary: "Media library", description: "Sent uploads and generated outputs (archived), newest first. `url` is a 1-hour signed URL or null when unavailable.", response: MediaLibraryPageSchema, query: page },
  { method: "get", path: "/api/v1/credits/balance", tag: "Credits", summary: "Credit balance", response: CreditBalanceResponseSchema },
  { method: "get", path: "/api/v1/credits/ledger", tag: "Credits", summary: "Credit ledger", response: PaginatedCreditLedgerResponseSchema, query: page },
  { method: "get", path: "/api/v1/webhooks", tag: "Webhooks", summary: "List webhook endpoints", response: WebhookEndpointListResponseSchema },
  { method: "post", path: "/api/v1/webhooks", tag: "Webhooks", summary: "Create webhook endpoint", description: "Public https URL only. The signing secret is returned only here.", request: CreateWebhookEndpointRequestSchema, response: CreatedWebhookEndpointResponseSchema, status: 201 },
  { method: "delete", path: "/api/v1/webhooks/{webhookId}", tag: "Webhooks", summary: "Disable webhook endpoint", response: WebhookEndpointResponseSchema },
];

const errorResponse = {
  description: "Error",
  content: {
    "application/json": {
      schema: {
        type: "object",
        properties: {
          ok: { const: false },
          error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } },
        },
      },
    },
  },
};

const paths: Record<string, Record<string, unknown>> = {};
for (const op of ops) {
  const params = [...op.path.matchAll(/\{(\w+)\}/g)].map(([, name]) => ({
    name,
    in: "path",
    required: true,
    schema: { type: "string", format: "uuid" },
  }));
  const parameters = [
    ...params,
    ...(op.query ?? []).map((q) => ({ name: q.name, in: "query", required: false, description: q.description, schema: q.schema })),
    ...(op.idempotent
      ? [{ name: "Idempotency-Key", in: "header", required: true, description: "Unique per intentional request; a retry with the same key returns the original result.", schema: { type: "string" } }]
      : []),
  ];
  paths[op.path] ??= {};
  paths[op.path][op.method] = {
    tags: [op.tag],
    summary: op.summary,
    ...(op.description ? { description: op.description } : {}),
    ...(op.path === "/api/health" ? { security: [] } : {}),
    parameters,
    ...(op.request ? { requestBody: { required: true, content: { "application/json": { schema: schema(op.request, "input") } } } } : {}),
    responses: {
      [String(op.status ?? 200)]: {
        description: "Success",
        content: { "application/json": { schema: op.path === "/api/health" ? { type: "object" } : envelope(op.response ?? null) } },
      },
      "400": errorResponse,
      "401": errorResponse,
      "404": errorResponse,
      "409": errorResponse,
    },
  };
}

const document = {
  openapi: "3.1.0",
  info: {
    title: "Agent Chat API",
    version: "1.0.0",
    description: "Versioned REST API for agent conversations, runs, approvals, media and credits. All `/api/v1` routes require a Clerk session token.",
  },
  servers: [{ url: "http://localhost:3001", description: "Local development" }],
  security: [{ bearerAuth: [] }],
  components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } } },
  paths,
  webhooks: {
    lifecycleEvent: {
      post: {
        summary: "Lifecycle event",
        description: "Sent for agent.started, agent.completed, agent.failed and tool.completed. Signed: webhook-id, webhook-timestamp, webhook-signature (v1, HMAC-SHA256).",
        requestBody: { content: { "application/json": { schema: schema(WebhookEventSchema, "output") } } },
        responses: { "200": { description: "Any 2xx acknowledges the delivery." } },
      },
    },
  },
};

const out = join(process.cwd(), "mintlify", "openapi.json");
writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`);
console.log(`Wrote ${out} (${ops.length} operations)`);
