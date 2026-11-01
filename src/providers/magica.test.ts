import { describe, it, expect, beforeAll, afterEach, afterAll, beforeEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { startMagicaRun, getMagicaRun, MagicaDefiniteError, MagicaAmbiguousError } from "./magica";

const BASE_URL = "https://inference.magica.test";
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const ORIGINAL_KEY = process.env.MAGICA_API_KEY;
const ORIGINAL_BASE_URL = process.env.MAGICA_BASE_URL;
const TEST_KEY = "test-magica-key-should-never-leak";
beforeEach(() => {
  process.env.MAGICA_API_KEY = TEST_KEY;
  process.env.MAGICA_BASE_URL = BASE_URL;
});
afterAll(() => {
  process.env.MAGICA_API_KEY = ORIGINAL_KEY;
  process.env.MAGICA_BASE_URL = ORIGINAL_BASE_URL;
});

describe("startMagicaRun", () => {
  it("returns {runId} on a valid 202 response", async () => {
    server.use(
      http.post(`${BASE_URL}/v1/nodes/crop_image/run`, () => HttpResponse.json({ runId: "run_abc123" }, { status: 202 })),
    );
    const result = await startMagicaRun("crop_image", { image_url: "https://example.com/a.png" });
    expect(result).toEqual({ runId: "run_abc123" });
  });

  it("sends the configured base URL, node type, input, and optional subModelId in the request", async () => {
    let capturedBody: unknown;
    let capturedUrl = "";
    server.use(
      http.post(`${BASE_URL}/v1/nodes/gpt_image_2/run`, async ({ request }) => {
        capturedUrl = request.url;
        capturedBody = await request.json();
        return HttpResponse.json({ runId: "run_xyz" }, { status: 202 });
      }),
    );
    await startMagicaRun("gpt_image_2", { prompt: "a cat" }, "gpt-image-2-text");
    expect(capturedUrl).toBe(`${BASE_URL}/v1/nodes/gpt_image_2/run`);
    expect(capturedBody).toEqual({ input: { prompt: "a cat" }, subModelId: "gpt-image-2-text" });
  });

  it("rejects a 202 response with a malformed body as MagicaAmbiguousError — a run may still have started", async () => {
    server.use(http.post(`${BASE_URL}/v1/nodes/crop_image/run`, () => HttpResponse.json({ not: "a runId" }, { status: 202 })));
    await expect(startMagicaRun("crop_image", {})).rejects.toBeInstanceOf(MagicaAmbiguousError);
  });

  it("classifies HTTP 400/404 as MagicaDefiniteError", async () => {
    server.use(http.post(`${BASE_URL}/v1/nodes/crop_image/run`, () => HttpResponse.json({ error: "bad" }, { status: 400 })));
    await expect(startMagicaRun("crop_image", {})).rejects.toBeInstanceOf(MagicaDefiniteError);
  });

  it("classifies HTTP 429 as MagicaDefiniteError with code RATE_LIMITED", async () => {
    server.use(http.post(`${BASE_URL}/v1/nodes/crop_image/run`, () => HttpResponse.json({ error: "slow down" }, { status: 429 })));
    await expect(startMagicaRun("crop_image", {})).rejects.toMatchObject({
      name: "MagicaDefiniteError",
      code: "RATE_LIMITED",
    });
  });

  it("classifies HTTP 5xx as MagicaAmbiguousError, NOT definite — a 500 does not prove no run was started", async () => {
    server.use(http.post(`${BASE_URL}/v1/nodes/crop_image/run`, () => HttpResponse.json({ error: "boom" }, { status: 500 })));
    await expect(startMagicaRun("crop_image", {})).rejects.toBeInstanceOf(MagicaAmbiguousError);
  });

  it("classifies a generic network/timeout failure as MagicaAmbiguousError, not provably pre-transmission", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockRejectedValueOnce(new DOMException("The operation was aborted", "AbortError"));
    await expect(startMagicaRun("crop_image", {})).rejects.toBeInstanceOf(MagicaAmbiguousError);
    fetchSpy.mockRestore();
  });

  it("classifies a connection-reset-after-transmission-may-have-begun failure as ambiguous, not pre-transmission", async () => {
    const resetError = new TypeError("fetch failed");
    (resetError as unknown as { cause: unknown }).cause = { code: "ECONNRESET" };
    const fetchSpy = vi.spyOn(global, "fetch").mockRejectedValueOnce(resetError);
    await expect(startMagicaRun("crop_image", {})).rejects.toMatchObject({ name: "MagicaAmbiguousError" });
    fetchSpy.mockRestore();
  });

  it("classifies a reliably-established pre-transmission connection failure (ECONNREFUSED) as MagicaDefiniteError", async () => {
    const refused = new TypeError("fetch failed");
    (refused as unknown as { cause: unknown }).cause = { code: "ECONNREFUSED" };
    const fetchSpy = vi.spyOn(global, "fetch").mockRejectedValueOnce(refused);
    await expect(startMagicaRun("crop_image", {})).rejects.toMatchObject({
      name: "MagicaDefiniteError",
      code: "MAGICA_START_NOT_SENT",
    });
    fetchSpy.mockRestore();
  });

  it("throws MagicaDefiniteError immediately, with no request made, when MAGICA_API_KEY is missing", async () => {
    delete process.env.MAGICA_API_KEY;
    let requestMade = false;
    server.use(
      http.post(`${BASE_URL}/v1/nodes/crop_image/run`, () => {
        requestMade = true;
        return HttpResponse.json({ runId: "x" }, { status: 202 });
      }),
    );
    await expect(startMagicaRun("crop_image", {})).rejects.toMatchObject({ code: "MISSING_API_KEY" });
    expect(requestMade).toBe(false);
  });

  it("never includes the API key in a thrown error's message", async () => {
    server.use(http.post(`${BASE_URL}/v1/nodes/crop_image/run`, () => HttpResponse.json({ error: "bad" }, { status: 400 })));
    try {
      await startMagicaRun("crop_image", {});
      expect.fail("expected startMagicaRun to throw");
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(TEST_KEY);
      expect(JSON.stringify(error)).not.toContain(TEST_KEY);
    }
  });
});

describe("getMagicaRun", () => {
  it("validates and returns a valid poll response, preserving `output` as unknown JSON", async () => {
    const output = { images: ["https://example.com/out.png"], nested: { anything: true } };
    server.use(
      http.get(`${BASE_URL}/v1/nodes/runs/run_abc`, () =>
        HttpResponse.json({ id: "run_abc", nodeType: "crop_image", status: "COMPLETED", createdAt: "2026-01-01T00:00:00Z", output }),
      ),
    );
    const result = await getMagicaRun("run_abc");
    expect(result.status).toBe("COMPLETED");
    expect(result.output).toEqual(output);
  });

  it.each(["QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELED"])("accepts the documented status %s without rejecting it", async (status) => {
    server.use(
      http.get(`${BASE_URL}/v1/nodes/runs/run_x`, () =>
        HttpResponse.json({ id: "run_x", nodeType: "crop_image", status, createdAt: "2026-01-01T00:00:00Z" }),
      ),
    );
    const result = await getMagicaRun("run_x");
    expect(result.status).toBe(status);
  });

  it("does not reject an unrecognized/unknown status at the schema level — callers decide how to handle it", async () => {
    server.use(
      http.get(`${BASE_URL}/v1/nodes/runs/run_weird`, () =>
        HttpResponse.json({ id: "run_weird", nodeType: "crop_image", status: "SOMETHING_NEW", createdAt: "2026-01-01T00:00:00Z" }),
      ),
    );
    const result = await getMagicaRun("run_weird");
    expect(result.status).toBe("SOMETHING_NEW");
  });

  it("rejects a malformed poll response (missing required fields) as MagicaAmbiguousError — safe to retry the poll", async () => {
    server.use(http.get(`${BASE_URL}/v1/nodes/runs/run_bad`, () => HttpResponse.json({ not: "a poll response" })));
    await expect(getMagicaRun("run_bad")).rejects.toBeInstanceOf(MagicaAmbiguousError);
  });

  it("treats any non-200 poll response as a transient, retry-safe MagicaAmbiguousError", async () => {
    server.use(http.get(`${BASE_URL}/v1/nodes/runs/run_404`, () => HttpResponse.json({ error: "not found" }, { status: 404 })));
    await expect(getMagicaRun("run_404")).rejects.toMatchObject({ name: "MagicaAmbiguousError", code: "MAGICA_POLL_TRANSIENT" });
  });

  it("treats a network/timeout failure during polling as a transient, retry-safe MagicaAmbiguousError", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockRejectedValueOnce(new DOMException("aborted", "AbortError"));
    await expect(getMagicaRun("run_timeout")).rejects.toMatchObject({ name: "MagicaAmbiguousError", code: "MAGICA_POLL_TRANSIENT" });
    fetchSpy.mockRestore();
  });

  it("never includes the API key in a thrown error's message", async () => {
    server.use(http.get(`${BASE_URL}/v1/nodes/runs/run_bad`, () => HttpResponse.json({ error: "bad" }, { status: 404 })));
    try {
      await getMagicaRun("run_bad");
      expect.fail("expected getMagicaRun to throw");
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(TEST_KEY);
    }
  });
});
