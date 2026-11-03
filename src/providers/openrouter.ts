import { z } from "zod";

// Real response shapes confirmed against two live openrouter/free calls
// (see project-docs/decisions/0010) — not guessed from docs, which don't
// document whether `model` reflects the actual routed model or a
// `reasoning` field separate from `content`. `model` genuinely varies
// per request (two calls returned two different underlying models).
// `reasoning` is the model's private scratch work (tool selection,
// parameter construction) and is deliberately dropped here: it is never
// returned, persisted, rendered, or substituted for a null `content`.
//
// The tool-calling request/response shapes added this checkpoint
// (`tools`, `tool_calls`, the `tool` message role) are NOT independently
// verified against a live call — doing so would mean sending a real
// tool definition to a real conversation, which checkpoint 2.3 is
// explicitly scoped to avoid. They follow OpenRouter's documented
// OpenAI-compatible schema (project-docs/decisions/0011) instead; the
// first genuine exercise of this path against the real API happens in
// Phase 3, when Magica tools are registered for real.

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const REQUIRED_MODEL = "openrouter/free";
const FREE_MODEL_SUFFIX = ":free";
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_COMPLETION_TOKENS = 2048;

export type ProviderToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type OpenRouterToolSpec = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ProviderMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | { role: "assistant"; content: string | null; tool_calls: ProviderToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type OpenRouterTurnResult = {
  /** The actual routed model, e.g. "nvidia/nemotron-3.5-lightning:free"
   * — never the literal "openrouter/free" alias. Verified to vary
   * per-request against the real API. */
  model: string;
  text: string | null;
  /** Non-null exactly when the model is requesting one or more tool
   * calls instead of (or alongside) a text answer. */
  toolCalls: ProviderToolCall[] | null;
  promptTokens: number;
  completionTokens: number;
};

/** A definitive outcome — OpenRouter responded (success or error), or we
 * rejected the request before sending it. Safe to finalize immediately;
 * never leaves anything ambiguous. */
export class OpenRouterDefiniteError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    /** Visible text already streamed before a mid-stream failure (preserved, never retried). */
    public readonly partialText: string | null = null,
  ) {
    super(message);
    this.name = "OpenRouterDefiniteError";
  }
}

/** We do not know whether OpenRouter received/processed the request —
 * our own timeout fired, or the network failed before any HTTP response
 * came back. Never treated as proof of failure; never auto-retried. */
export class OpenRouterAmbiguousError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenRouterAmbiguousError";
  }
}

const ToolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

// Phase 3.1: a provider response with two tool_calls sharing the same
// `id` is a protocol violation, not a per-tool-call input problem — the
// `id` is the correlation key OpenRouter's own protocol uses to match
// each `tool`-role reply to its request, and `run-agent-turn.ts` uses
// it to build `ToolInvocation.idempotencyKey` (unique in the schema).
// Treating this as malformed-response (the existing MALFORMED_RESPONSE
// path below) rather than inventing a new tool-level error means a
// duplicate id can never reach the point of attempting two inserts
// under one unique key — no new mechanism, reuses the same
// OpenRouterDefiniteError path a non-conforming body already takes.
const MessageSchema = z
  .object({
    content: z.string().nullable(),
    tool_calls: z.array(ToolCallSchema).optional(),
  })
  .refine(
    (message) =>
      !message.tool_calls || new Set(message.tool_calls.map((call) => call.id)).size === message.tool_calls.length,
    { message: "Duplicate tool_call id in provider response" },
  );

const ChoiceSchema = z.object({
  message: MessageSchema,
});

const UsageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
});

const SuccessResponseSchema = z.object({
  model: z.string(),
  choices: z.array(ChoiceSchema).min(1),
  usage: UsageSchema,
});

const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.union([z.number(), z.string()]).optional(),
    message: z.string(),
  }),
});

function errorCodeForStatus(status: number): string {
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "PROVIDER_UNAVAILABLE";
  return "PROVIDER_ERROR";
}

export type CallOpenRouterOptions = {
  /** Streams the response (`stream: true`) and receives each visible text
   * delta, in order, after the routed model is verified free. Reasoning
   * deltas are never forwarded. An error thrown here aborts the stream and
   * propagates unchanged (e.g. the run was cancelled). */
  onTextDelta?: (delta: string) => void | Promise<void>;
};

/** Between streamed chunks; a stalled stream is a failure, not a hang. */
const STREAM_IDLE_TIMEOUT_MS = 60_000;

/**
 * Calls OpenRouter's free route for one chat turn. Throws
 * OpenRouterDefiniteError for any outcome we can finalize immediately
 * (config rejected, HTTP error, malformed body, non-free route, empty
 * response), or OpenRouterAmbiguousError when we genuinely don't know
 * what happened (our timeout fired, or the network failed before any
 * response arrived) — callers must never treat the latter as a safe-to-
 * retry failure. See run-agent-turn.ts for how each is handled.
 *
 * `tools` is omitted from the request entirely when empty, so a call
 * with no tools (every production call today — the registry is empty
 * per Decision A) is byte-identical to the pre-2.3 request.
 */
export async function callOpenRouter(
  messages: ProviderMessage[],
  tools: OpenRouterToolSpec[] = [],
  options: CallOpenRouterOptions = {},
): Promise<OpenRouterTurnResult> {
  const configuredModel = process.env.OPENROUTER_MODEL;
  if (configuredModel !== REQUIRED_MODEL) {
    // A configuration problem, not a provider outcome — rejected before
    // any request is sent, so this can never be ambiguous.
    throw new OpenRouterDefiniteError(
      `OPENROUTER_MODEL must be "${REQUIRED_MODEL}"; no paid fallback is permitted`,
      "UNSUPPORTED_MODEL_CONFIG",
    );
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new OpenRouterDefiniteError(
      "OPENROUTER_API_KEY is not configured",
      "MISSING_API_KEY",
    );
  }

  const controller = new AbortController();
  let timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: configuredModel,
        messages,
        max_completion_tokens: MAX_COMPLETION_TOKENS,
        ...(tools.length > 0 ? { tools } : {}),
        ...(options.onTextDelta ? { stream: true } : {}),
      }),
      signal: controller.signal,
    });
  } catch (error) {
    // Our timeout aborting, DNS failure, connection reset — in every
    // case we never received an HTTP response, so we cannot know
    // whether OpenRouter processed the request. Ambiguous by
    // definition, not a clean failure.
    throw new OpenRouterAmbiguousError(
      error instanceof Error ? error.message : "Network error calling OpenRouter",
    );
  } finally {
    clearTimeout(timeout);
  }

  if (options.onTextDelta && response.ok) {
    timeout = setTimeout(() => controller.abort(), STREAM_IDLE_TIMEOUT_MS);
    try {
      return await readStreamedTurn(response, options.onTextDelta, () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => controller.abort(), STREAM_IDLE_TIMEOUT_MS);
      });
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }

  // Any HTTP response at all — success or error — is a definitive,
  // synchronously-known outcome: OpenRouter received the request and
  // told us what happened. Only the absence of a response is ambiguous.
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const parsed = ErrorResponseSchema.safeParse(body);
    throw new OpenRouterDefiniteError(
      parsed.success ? parsed.data.error.message : `OpenRouter returned HTTP ${response.status}`,
      errorCodeForStatus(response.status),
    );
  }

  const body: unknown = await response.json().catch(() => null);
  const parsed = SuccessResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new OpenRouterDefiniteError(
      "OpenRouter returned a response that didn't match the expected shape",
      "MALFORMED_RESPONSE",
    );
  }

  const { model, choices, usage } = parsed.data;

  // The response is well-formed but routed somewhere we never
  // authorized — the requested model name is not proof of the actual
  // route; verify the response itself. Never silently accept a
  // possibly-paid completion.
  if (!model.endsWith(FREE_MODEL_SUFFIX)) {
    throw new OpenRouterDefiniteError(
      `Provider routed to a non-free model (${model}); refusing to use the result`,
      "NON_FREE_ROUTE",
    );
  }

  const text = choices[0].message.content?.trim() || null;
  const toolCalls = choices[0].message.tool_calls?.length ? choices[0].message.tool_calls : null;
  // A reasoning-only response (content null, no tool calls) has nothing
  // user-visible or actionable, so it is empty, not a success.
  if (!text && !toolCalls) {
    throw new OpenRouterDefiniteError(
      "OpenRouter returned an empty response",
      "EMPTY_RESPONSE",
    );
  }

  return {
    model,
    text,
    toolCalls,
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
  };
}

// ---------- Streaming (SSE) ----------
// OpenAI-compatible chunks: `data: {json}` lines, `: comment` keep-alives,
// a final `data: [DONE]`. Tool calls arrive as deltas keyed by `index`
// (id/name once, arguments concatenated). The final chunk carries usage.
// A mid-stream `error` object is a provider error delivered after HTTP 200.

const StreamToolCallDeltaSchema = z.object({
  index: z.number().int().nonnegative(),
  id: z.string().optional(),
  type: z.literal("function").optional(),
  function: z.object({ name: z.string().optional(), arguments: z.string().optional() }).optional(),
});

const StreamChunkSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        delta: z
          .object({
            content: z.string().nullish(),
            tool_calls: z.array(StreamToolCallDeltaSchema).nullish(),
          })
          .optional(),
      }),
    )
    .optional(),
  usage: UsageSchema.nullish(),
  error: z.object({ code: z.union([z.number(), z.string()]).optional(), message: z.string() }).optional(),
});

/** Splits a byte stream into SSE `data:` payloads (comments and blank lines dropped). */
async function* sseData(body: ReadableStream<Uint8Array>, onActivity: () => void): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onActivity();
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
    }
    const last = buffer.trim();
    if (last.startsWith("data:")) yield last.slice(5).trim();
  } finally {
    reader.releaseLock();
  }
}

async function readStreamedTurn(
  response: Response,
  onTextDelta: (delta: string) => void | Promise<void>,
  onActivity: () => void,
): Promise<OpenRouterTurnResult> {
  if (!response.body) {
    throw new OpenRouterDefiniteError("OpenRouter returned an empty stream", "EMPTY_RESPONSE");
  }
  let model: string | null = null;
  let text = "";
  let usage: z.infer<typeof UsageSchema> | null = null;
  const calls = new Map<number, { id?: string; name: string; arguments: string }>();
  function fail(message: string, code: string): never {
    throw new OpenRouterDefiniteError(message, code, text.trim() || null);
  }
  // An error thrown by the caller's own callback is passed through unchanged.
  let callbackError: { error: unknown } | null = null;
  let sawDone = false;

  try {
    for await (const data of sseData(response.body, onActivity)) {
      if (data === "[DONE]") {
        sawDone = true;
        break;
      }
      let json: unknown;
      try {
        json = JSON.parse(data);
      } catch {
        fail("OpenRouter streamed a chunk that wasn't valid JSON", "MALFORMED_RESPONSE");
      }
      const parsed = StreamChunkSchema.safeParse(json);
      if (!parsed.success) fail("OpenRouter streamed a chunk that didn't match the expected shape", "MALFORMED_RESPONSE");
      const chunk = parsed.data;
      if (chunk.error) fail(chunk.error.message, "PROVIDER_ERROR");

      if (chunk.model) {
        // Verified before any text is forwarded: a non-free route's output is never shown.
        if (!chunk.model.endsWith(FREE_MODEL_SUFFIX)) {
          fail(`Provider routed to a non-free model (${chunk.model}); refusing to use the result`, "NON_FREE_ROUTE");
        }
        model = chunk.model;
      }
      if (chunk.usage) usage = chunk.usage;

      const delta = chunk.choices?.[0]?.delta;
      for (const call of delta?.tool_calls ?? []) {
        const entry = calls.get(call.index) ?? { name: "", arguments: "" };
        if (call.id) entry.id = call.id;
        if (call.function?.name) entry.name += call.function.name;
        if (call.function?.arguments) entry.arguments += call.function.arguments;
        calls.set(call.index, entry);
      }
      if (delta?.content) {
        if (!model) fail("OpenRouter streamed text before identifying the routed model", "MALFORMED_RESPONSE");
        text += delta.content;
        try {
          await onTextDelta(delta.content);
        } catch (error) {
          callbackError = { error };
          throw error;
        }
      }
    }
  } catch (error) {
    if (callbackError || error instanceof OpenRouterDefiniteError) throw error;
    // Our idle timeout or a dropped connection after HTTP 200: the request
    // was received and is known to have failed part-way. Free route, no side
    // effects; the partial text is preserved by the caller, never retried.
    if (isTransportError(error)) {
      fail("The OpenRouter stream was interrupted before it finished", "STREAM_INTERRUPTED");
    }
    throw error; // e.g. onTextDelta's own error (run cancelled) — unchanged
  }
  // OpenRouter always terminates a complete stream with [DONE]; without it
  // the body was cut off (a dropped connection can also end "cleanly").
  if (!sawDone) fail("The OpenRouter stream ended before it finished", "STREAM_INTERRUPTED");

  if (!model) return fail("OpenRouter's stream never identified the routed model", "MALFORMED_RESPONSE");

  const toolCalls: ProviderToolCall[] = [];
  for (const [, call] of [...calls.entries()].sort(([a], [b]) => a - b)) {
    const parsed = ToolCallSchema.safeParse({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } });
    if (!parsed.success) fail("OpenRouter streamed an incomplete tool call", "MALFORMED_RESPONSE");
    toolCalls.push(parsed.data);
  }
  if (new Set(toolCalls.map((c) => c.id)).size !== toolCalls.length) {
    fail("Duplicate tool_call id in provider response", "MALFORMED_RESPONSE");
  }

  const trimmed = text.trim() || null;
  if (!trimmed && toolCalls.length === 0) {
    throw new OpenRouterDefiniteError("OpenRouter returned an empty response", "EMPTY_RESPONSE");
  }
  return {
    model,
    text: trimmed,
    toolCalls: toolCalls.length ? toolCalls : null,
    promptTokens: usage?.prompt_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
  };
}

/** Errors raised by the body reader itself (abort, reset), not by our own code. */
function isTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.name === "TypeError" || /terminated|aborted|socket|ECONNRESET/i.test(error.message);
}
