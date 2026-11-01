import { z } from "zod";

// Real response shapes confirmed against two live openrouter/free calls
// (see project-docs/decisions/0010) — not guessed from docs, which don't
// document whether `model` reflects the actual routed model or a
// `reasoning` field separate from `content`. Both are real and load-
// bearing: `model` genuinely varies per request (two calls returned two
// different underlying models) and `content` can be null when the
// model spends its whole token budget on `reasoning`.
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
  reasoning: string | null;
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
  id: z.string(),
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

const MessageSchema = z.object({
  content: z.string().nullable(),
  reasoning: z.string().nullable().optional(),
  tool_calls: z.array(ToolCallSchema).optional(),
});

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
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

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
  const reasoning = choices[0].message.reasoning?.trim() || null;
  const toolCalls = choices[0].message.tool_calls?.length ? choices[0].message.tool_calls : null;
  if (!text && !reasoning && !toolCalls) {
    throw new OpenRouterDefiniteError(
      "OpenRouter returned an empty response",
      "EMPTY_RESPONSE",
    );
  }

  return {
    model,
    text,
    reasoning,
    toolCalls,
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
  };
}
