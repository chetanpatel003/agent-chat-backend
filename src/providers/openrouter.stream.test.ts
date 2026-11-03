import { describe, it, expect, vi, afterEach, afterAll, beforeEach } from "vitest";
import { callOpenRouter, OpenRouterAmbiguousError, OpenRouterDefiniteError } from "./openrouter";

// Streaming (SSE) fixtures for the OpenAI-compatible chunk format OpenRouter
// documents. No live calls.
//
// `fetch` is stubbed directly with real `Response` objects instead of MSW:
// under full-suite load, MSW's Node interceptor intermittently failed a
// streamed request at the fetch level ("fetch failed"), in whichever test
// happened to be in flight. Stubbing fetch keeps every body under the test's
// own control.

const URL = "https://openrouter.ai/api/v1/chat/completions";

const ORIGINAL_MODEL = process.env.OPENROUTER_MODEL;
const ORIGINAL_KEY = process.env.OPENROUTER_API_KEY;
beforeEach(() => {
  process.env.OPENROUTER_MODEL = "openrouter/free";
  process.env.OPENROUTER_API_KEY = "test-key";
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(() => {
  process.env.OPENROUTER_MODEL = ORIGINAL_MODEL;
  process.env.OPENROUTER_API_KEY = ORIGINAL_KEY;
});

const MODEL = "nvidia/nemotron-3.5-super-vl:free";

function chunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { id: "gen-1", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta }], ...extra };
}

/** Raw SSE lines as a body stream, ending in [DONE], a clean cut (omitDone),
 * or a reader error like undici's "terminated" (breakAtEnd). */
function sseStream(lines: (Record<string, unknown> | string)[], opts: { breakAtEnd?: boolean; omitDone?: boolean } = {}) {
  const encoder = new TextEncoder();
  const pending = lines.map((line) => `${typeof line === "string" ? line : `data: ${JSON.stringify(line)}`}\n\n`);
  let cancelled = false; // the adapter cancels the body when it stops early
  return new ReadableStream<Uint8Array>({
    // Pull-based, one line per read, so a break happens after the response
    // (and its earlier chunks) were delivered — a real mid-stream drop.
    async pull(controller) {
      if (cancelled) return;
      const next = pending.shift();
      if (next !== undefined) return controller.enqueue(encoder.encode(next));
      await new Promise((r) => setTimeout(r, 5));
      if (cancelled) return;
      if (opts.breakAtEnd) controller.error(new TypeError("terminated"));
      else if (opts.omitDone) controller.close();
      else {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
    cancel() {
      cancelled = true;
    },
  });
}

/** Serves the next fetch with an SSE response; returns the spy (its calls carry the request). */
function serveSse(lines: (Record<string, unknown> | string)[], opts: { breakAtEnd?: boolean; omitDone?: boolean } = {}) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response(sseStream(lines, opts), { headers: { "Content-Type": "text/event-stream" } }),
  );
}

const usage = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 };
const call = (onTextDelta: (d: string) => void = () => {}) =>
  callOpenRouter([{ role: "user", content: "hi" }], [], { onTextDelta }).catch((e) => e);

describe("callOpenRouter — streaming", () => {
  it("requests stream: true and forwards visible text deltas in order", async () => {
    const spy = serveSse([
      ": OPENROUTER PROCESSING",
      chunk({ role: "assistant", content: "" }),
      chunk({ reasoning: "private scratch work" }),
      chunk({ content: "Hel" }),
      chunk({ content: "lo" }),
      chunk({}, { usage }),
    ]);
    const deltas: string[] = [];
    const result = await callOpenRouter([{ role: "user", content: "hi" }], [], { onTextDelta: (d) => void deltas.push(d) });
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe(URL);
    expect(JSON.parse(String(init?.body))).toMatchObject({ stream: true, model: "openrouter/free" });
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(result).toEqual({ model: MODEL, text: "Hello", toolCalls: null, promptTokens: 10, completionTokens: 3 });
    expect(JSON.stringify(result)).not.toContain("private scratch work");
  });

  it("assembles tool calls from index-keyed deltas, ordered by index", async () => {
    serveSse([
      chunk({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "load_skill", arguments: "" } }] }),
      chunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "crop_image", arguments: '{"x"' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: ":1}" } }] }),
      chunk({ tool_calls: [{ index: 1, function: { arguments: '{"name":"s"}' } }] }),
      chunk({}, { usage }),
    ]);
    const result = await callOpenRouter([{ role: "user", content: "hi" }], [], { onTextDelta: () => {} });
    expect(result.text).toBeNull();
    expect(result.toolCalls).toEqual([
      { id: "call_a", type: "function", function: { name: "crop_image", arguments: '{"x":1}' } },
      { id: "call_b", type: "function", function: { name: "load_skill", arguments: '{"name":"s"}' } },
    ]);
  });

  it("refuses a non-free route before forwarding any text", async () => {
    serveSse([{ ...chunk({ content: "paid output" }), model: "openai/gpt-5" }]);
    const deltas: string[] = [];
    const error = await call((d) => void deltas.push(d));
    expect(error).toBeInstanceOf(OpenRouterDefiniteError);
    expect(error.code).toBe("NON_FREE_ROUTE");
    expect(deltas).toEqual([]);
  });

  it("a mid-stream disconnect is a definite STREAM_INTERRUPTED carrying the partial text", async () => {
    serveSse([chunk({ content: "Partial " }), chunk({ content: "answer" })], { breakAtEnd: true });
    const error = await call();
    expect(error).toBeInstanceOf(OpenRouterDefiniteError);
    expect(error.code).toBe("STREAM_INTERRUPTED");
    expect(error.partialText).toBe("Partial answer");
  });

  it("a mid-stream provider error object is a definite PROVIDER_ERROR", async () => {
    serveSse([chunk({ content: "Some" }), { error: { code: 502, message: "Upstream failed" } }]);
    expect(await call()).toMatchObject({ code: "PROVIDER_ERROR", partialText: "Some", message: "Upstream failed" });
  });

  it("a malformed chunk is MALFORMED_RESPONSE", async () => {
    serveSse(["data: {not json"]);
    expect(await call()).toMatchObject({ code: "MALFORMED_RESPONSE" });
  });

  it("an incomplete streamed tool call (no id) is MALFORMED_RESPONSE", async () => {
    serveSse([chunk({ tool_calls: [{ index: 0, function: { name: "crop_image", arguments: "{}" } }] })]);
    expect(await call()).toMatchObject({ code: "MALFORMED_RESPONSE" });
  });

  it("an empty stream (only [DONE]) is EMPTY_RESPONSE", async () => {
    serveSse([chunk({ role: "assistant", content: "" })]);
    expect(await call()).toMatchObject({ code: "EMPTY_RESPONSE" });
  });

  it("a stream that ends without [DONE] is also STREAM_INTERRUPTED (truncated, not complete)", async () => {
    serveSse([chunk({ content: "Cut" })], { omitDone: true });
    expect(await call()).toMatchObject({ code: "STREAM_INTERRUPTED", partialText: "Cut" });
  });

  it("an HTTP error before streaming starts stays a definite error with its status code mapping", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({ error: { code: 429, message: "Rate limited" } }, { status: 429 }),
    );
    expect(await call()).toMatchObject({ code: "RATE_LIMITED" });
  });

  it("a network failure before any response stays ambiguous", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await call()).toBeInstanceOf(OpenRouterAmbiguousError);
  });

  it("an error thrown by the caller's callback (e.g. run cancelled) propagates unchanged", async () => {
    class Stop extends Error {}
    serveSse([chunk({ content: "a" }), chunk({ content: "b" })]);
    const error = await call(() => {
      throw new Stop("cancelled");
    });
    expect(error).toBeInstanceOf(Stop);
  });
});
