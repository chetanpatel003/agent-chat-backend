import { describe, it, expect, beforeAll, afterEach, afterAll, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { callOpenRouter, OpenRouterAmbiguousError } from "./openrouter";

const URL = "https://openrouter.ai/api/v1/chat/completions";
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const ORIGINAL_MODEL = process.env.OPENROUTER_MODEL;
const ORIGINAL_KEY = process.env.OPENROUTER_API_KEY;
beforeEach(() => {
  process.env.OPENROUTER_MODEL = "openrouter/free";
  process.env.OPENROUTER_API_KEY = "test-key";
});
afterAll(() => {
  process.env.OPENROUTER_MODEL = ORIGINAL_MODEL;
  process.env.OPENROUTER_API_KEY = ORIGINAL_KEY;
});

// Modeled on two real, live openrouter/free responses captured during
// this checkpoint's design pass — see project-docs/decisions/0010.
function realShapeSuccess(overrides: Record<string, unknown> = {}) {
  return {
    id: "gen-1793531561-GmhMp0thePeJRd4xGHdc",
    object: "chat.completion",
    created: 1793531561,
    model: "nvidia/nemotron-3.5-super-vl:free",
    provider: "nvidia",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: "pong",
          refusal: null,
          reasoning: "The user wants a one-word reply.",
        },
      },
    ],
    usage: { prompt_tokens: 24, completion_tokens: 49, total_tokens: 73, cost: 0 },
    ...overrides,
  };
}

describe("callOpenRouter — success", () => {
  it("returns the real routed model, content as text, and token usage — never the reasoning alongside it", async () => {
    server.use(http.post(URL, () => HttpResponse.json(realShapeSuccess())));
    const result = await callOpenRouter([{ role: "user", content: "ping" }]);
    expect(result.model).toBe("nvidia/nemotron-3.5-super-vl:free");
    expect(result.text).toBe("pong");
    expect(result.promptTokens).toBe(24);
    expect(result.completionTokens).toBe(49);
    expect(result).not.toHaveProperty("reasoning");
    expect(JSON.stringify(result)).not.toContain("The user wants a one-word reply.");
  });

  it("treats content: null with only reasoning (a real live shape) as EMPTY_RESPONSE — never substitutes reasoning for content", async () => {
    server.use(
      http.post(URL, () =>
        HttpResponse.json(
          realShapeSuccess({
            choices: [
              {
                index: 0,
                finish_reason: "length",
                message: { role: "assistant", content: null, reasoning: "Here's a thinking process:" },
              },
            ],
          }),
        ),
      ),
    );
    await expect(callOpenRouter([{ role: "user", content: "ping" }])).rejects.toMatchObject({
      name: "OpenRouterDefiniteError",
      code: "EMPTY_RESPONSE",
    });
  });

  it("refuses a response that didn't actually route to a free model, even though it's otherwise well-formed", async () => {
    server.use(
      http.post(URL, () => HttpResponse.json(realShapeSuccess({ model: "openai/gpt-4o" }))),
    );
    await expect(callOpenRouter([{ role: "user", content: "ping" }])).rejects.toMatchObject({
      name: "OpenRouterDefiniteError",
      code: "NON_FREE_ROUTE",
    });
  });

  it("treats a response with neither content nor tool calls as a definite failure, not a silent empty success", async () => {
    server.use(
      http.post(URL, () =>
        HttpResponse.json(
          realShapeSuccess({
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: null, reasoning: null } }],
          }),
        ),
      ),
    );
    await expect(callOpenRouter([{ role: "user", content: "ping" }])).rejects.toMatchObject({
      code: "EMPTY_RESPONSE",
    });
  });
});

describe("callOpenRouter — definite failures (OpenRouter responded)", () => {
  it("maps 429 to RATE_LIMITED", async () => {
    server.use(
      http.post(URL, () =>
        HttpResponse.json({ error: { code: 429, message: "Rate limit exceeded" } }, { status: 429 }),
      ),
    );
    await expect(callOpenRouter([{ role: "user", content: "x" }])).rejects.toMatchObject({
      name: "OpenRouterDefiniteError",
      code: "RATE_LIMITED",
      message: "Rate limit exceeded",
    });
  });

  it("maps 500 to PROVIDER_UNAVAILABLE", async () => {
    server.use(
      http.post(URL, () =>
        HttpResponse.json({ error: { code: 500, message: "Internal error" } }, { status: 500 }),
      ),
    );
    await expect(callOpenRouter([{ role: "user", content: "x" }])).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
  });

  it("treats a malformed success body as a definite failure via boundary validation, not a crash", async () => {
    server.use(http.post(URL, () => HttpResponse.json({ not: "the expected shape" })));
    await expect(callOpenRouter([{ role: "user", content: "x" }])).rejects.toMatchObject({
      name: "OpenRouterDefiniteError",
      code: "MALFORMED_RESPONSE",
    });
  });

  it("rejects a paid/unsupported model configuration without making any request", async () => {
    process.env.OPENROUTER_MODEL = "openai/gpt-4o";
    let requestMade = false;
    server.use(
      http.post(URL, () => {
        requestMade = true;
        return HttpResponse.json(realShapeSuccess());
      }),
    );
    await expect(callOpenRouter([{ role: "user", content: "x" }])).rejects.toMatchObject({
      code: "UNSUPPORTED_MODEL_CONFIG",
    });
    expect(requestMade).toBe(false);
  });
});

describe("callOpenRouter — ambiguous outcomes (no response received)", () => {
  it("treats a network failure as ambiguous, not a clean failure", async () => {
    server.use(http.post(URL, () => HttpResponse.error()));
    await expect(callOpenRouter([{ role: "user", content: "x" }])).rejects.toBeInstanceOf(
      OpenRouterAmbiguousError,
    );
  });
});

// Tool-calling shapes below follow OpenRouter's documented OpenAI-
// compatible schema (project-docs/decisions/0011), not a live call — see
// openrouter.ts's top-of-file note for why checkpoint 2.3 deliberately
// didn't make one.
describe("callOpenRouter — tool calling", () => {
  it("sends the tools field only when tools are actually provided", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    server.use(
      http.post(URL, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(realShapeSuccess());
      }),
    );
    await callOpenRouter([{ role: "user", content: "ping" }]);
    expect(capturedBody).not.toHaveProperty("tools");

    const tools = [
      {
        type: "function" as const,
        function: { name: "get_current_time", description: "d", parameters: { type: "object" } },
      },
    ];
    await callOpenRouter([{ role: "user", content: "ping" }], tools);
    expect(capturedBody?.tools).toEqual(tools);
  });

  it("parses tool_calls out of the response, leaving text null", async () => {
    server.use(
      http.post(URL, () =>
        HttpResponse.json(
          realShapeSuccess({
            choices: [
              {
                index: 0,
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_abc123",
                      type: "function",
                      function: { name: "get_current_time", arguments: '{"timezone":"UTC"}' },
                    },
                  ],
                },
              },
            ],
          }),
        ),
      ),
    );
    const result = await callOpenRouter([{ role: "user", content: "what time is it" }]);
    expect(result.text).toBeNull();
    expect(result.toolCalls).toEqual([
      {
        id: "call_abc123",
        type: "function",
        function: { name: "get_current_time", arguments: '{"timezone":"UTC"}' },
      },
    ]);
  });

  it("returns tool calls from a response that also carries reasoning, without exposing the reasoning", async () => {
    server.use(
      http.post(URL, () =>
        HttpResponse.json(
          realShapeSuccess({
            choices: [
              {
                index: 0,
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  reasoning: "I should call generate_image with prompt 'Kashmir'.",
                  tool_calls: [
                    { id: "call_r", type: "function", function: { name: "generate_image", arguments: "{}" } },
                  ],
                },
              },
            ],
          }),
        ),
      ),
    );
    const result = await callOpenRouter([{ role: "user", content: "x" }]);
    expect(result.text).toBeNull();
    expect(result.toolCalls).toHaveLength(1);
    expect(result).not.toHaveProperty("reasoning");
    expect(JSON.stringify(result)).not.toContain("I should call generate_image");
  });

  it("does not treat a tool_calls-only response (no text) as empty", async () => {
    server.use(
      http.post(URL, () =>
        HttpResponse.json(
          realShapeSuccess({
            choices: [
              {
                index: 0,
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    { id: "call_1", type: "function", function: { name: "t", arguments: "{}" } },
                  ],
                },
              },
            ],
          }),
        ),
      ),
    );
    await expect(
      callOpenRouter([{ role: "user", content: "x" }]),
    ).resolves.toMatchObject({ text: null });
  });

  it("returns toolCalls: null for an ordinary text response", async () => {
    server.use(http.post(URL, () => HttpResponse.json(realShapeSuccess())));
    const result = await callOpenRouter([{ role: "user", content: "ping" }]);
    expect(result.toolCalls).toBeNull();
  });

  // Phase 3.1 — tool-call validation hardening.
  it("rejects a response with two tool_calls sharing the same id, as a malformed response — not a crash later when persisting it", async () => {
    server.use(
      http.post(URL, () =>
        HttpResponse.json(
          realShapeSuccess({
            choices: [
              {
                index: 0,
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    { id: "dup", type: "function", function: { name: "a", arguments: "{}" } },
                    { id: "dup", type: "function", function: { name: "b", arguments: "{}" } },
                  ],
                },
              },
            ],
          }),
        ),
      ),
    );
    await expect(callOpenRouter([{ role: "user", content: "x" }])).rejects.toMatchObject({
      name: "OpenRouterDefiniteError",
      code: "MALFORMED_RESPONSE",
    });
  });

  it("rejects a tool_call with an empty id the same way", async () => {
    server.use(
      http.post(URL, () =>
        HttpResponse.json(
          realShapeSuccess({
            choices: [
              {
                index: 0,
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [{ id: "", type: "function", function: { name: "a", arguments: "{}" } }],
                },
              },
            ],
          }),
        ),
      ),
    );
    await expect(callOpenRouter([{ role: "user", content: "x" }])).rejects.toMatchObject({
      name: "OpenRouterDefiniteError",
      code: "MALFORMED_RESPONSE",
    });
  });
});
