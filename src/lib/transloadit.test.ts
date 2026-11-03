import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  createUploadAuthorization,
  fetchAssemblyStatus,
  nonceFromStatus,
  signParams,
  TransloaditConfigError,
  TransloaditUnavailableError,
  UPLOAD_AUTH_TTL_MS,
} from "./transloadit";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const ORIGINAL = { key: process.env.TRANSLOADIT_KEY, secret: process.env.TRANSLOADIT_SECRET };
beforeEach(() => {
  process.env.TRANSLOADIT_KEY = "test-key";
  process.env.TRANSLOADIT_SECRET = "test-secret";
});
afterAll(() => {
  process.env.TRANSLOADIT_KEY = ORIGINAL.key;
  process.env.TRANSLOADIT_SECRET = ORIGINAL.secret;
});

const ASSEMBLY_ID = "0123456789abcdef0123456789abcdef";
const STATUS_URL = `https://api2.transloadit.com/assemblies/${ASSEMBLY_ID}`;

describe("createUploadAuthorization", () => {
  it("signs the exact params string with HMAC-SHA384 and a sha384: prefix", () => {
    const now = new Date("2026-11-02T10:00:00.000Z");
    const auth = createUploadAuthorization("att-1:nonce", now);
    const expected = createHmac("sha384", "test-secret").update(auth.params).digest("hex");
    expect(auth.signature).toBe(`sha384:${expected}`);
    expect(signParams(auth.params, "test-secret")).toBe(auth.signature);
  });

  it("puts key, ISO expiry, nonce and an :original-only step in the signed params — never the secret", () => {
    const now = new Date("2026-11-02T10:00:00.000Z");
    const auth = createUploadAuthorization("att-1:nonce", now);
    const params = JSON.parse(auth.params);
    expect(params).toEqual({
      auth: { key: "test-key", expires: new Date(now.getTime() + UPLOAD_AUTH_TTL_MS).toISOString() },
      nonce: "att-1:nonce",
      steps: { ":original": { robot: "/upload/handle" } },
    });
    expect(auth.expiresAt).toBe(params.auth.expires);
    expect(JSON.stringify(auth)).not.toContain("test-secret");
  });

  it("refuses to sign when credentials are not configured", () => {
    process.env.TRANSLOADIT_SECRET = "";
    expect(() => createUploadAuthorization("x")).toThrow(TransloaditConfigError);
  });
});

describe("fetchAssemblyStatus", () => {
  it("parses a completed Assembly", async () => {
    server.use(
      http.get(STATUS_URL, () =>
        HttpResponse.json({
          assembly_id: ASSEMBLY_ID,
          ok: "ASSEMBLY_COMPLETED",
          params: JSON.stringify({ auth: { key: "****" }, nonce: "att:1" }),
          uploads: [{ mime: "image/png", size: 10, ssl_url: "https://tmp.transloadit.com/a.png", meta: { width: 2, height: 3 } }],
        }),
      ),
    );
    const status = await fetchAssemblyStatus(ASSEMBLY_ID);
    expect(status?.ok).toBe("ASSEMBLY_COMPLETED");
    expect(status && nonceFromStatus(status)).toBe("att:1");
  });

  it("rejects a non-hex assembly id before making any request (no URL injection)", async () => {
    await expect(fetchAssemblyStatus("../../evil")).rejects.toThrow();
  });

  it("returns null for a malformed body", async () => {
    server.use(http.get(STATUS_URL, () => HttpResponse.json({ nonsense: true })));
    expect(await fetchAssemblyStatus(ASSEMBLY_ID)).toBeNull();
  });

  it("surfaces 5xx and network failures as retriable unavailability", async () => {
    server.use(http.get(STATUS_URL, () => new HttpResponse(null, { status: 503 })));
    await expect(fetchAssemblyStatus(ASSEMBLY_ID)).rejects.toThrow(TransloaditUnavailableError);
    server.use(http.get(STATUS_URL, () => HttpResponse.error()));
    await expect(fetchAssemblyStatus(ASSEMBLY_ID)).rejects.toThrow(TransloaditUnavailableError);
  });

  it("finds no nonce in missing or unparseable params", () => {
    expect(nonceFromStatus({ assembly_id: ASSEMBLY_ID })).toBeNull();
    expect(nonceFromStatus({ assembly_id: ASSEMBLY_ID, params: "{not json" })).toBeNull();
  });
});
