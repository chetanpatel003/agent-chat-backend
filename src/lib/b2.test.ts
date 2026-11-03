import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";

// Network safety net: if any request ever bypasses MSW, DNS fails instead
// of reaching a real host.
vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns")>();
  const lookup = (_h: string, _o: unknown, cb: (e: Error) => void) =>
    cb(Object.assign(new Error("DNS disabled in tests"), { code: "ENOTFOUND" }));
  return { ...actual, default: { ...actual, lookup }, lookup };
});
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { http, HttpResponse, delay } from "msw";
import { setupServer } from "msw/node";
import type { LookupAddress } from "node:dns";
import {
  ALLOWED_SOURCE_HOSTS,
  assertKeyOwnedBy,
  copyUrlToObject,
  createSafeLookup,
  generatedObjectKey,
  isPublicAddress,
  openSourceStream,
  putObjectStream,
  signedGetUrl,
  SourceFetchError,
  StorageConfigError,
  StorageUnavailableError,
  uploadObjectKey,
} from "./b2";

// A reserved .test host can never resolve, so no request can reach real B2.
const ENDPOINT = "https://s3.us-east-005.backblazeb2.test";
const BUCKET = "agentChat";
const FAKE_KEY_ID = "0050000000000000000000001";
const FAKE_SECRET = "K005FAKEAPPLICATIONKEYSECRETVAL";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const B2_VARS = ["B2_KEY_ID", "B2_APPLICATION_KEY", "B2_BUCKET_NAME", "B2_ENDPOINT", "B2_REGION"] as const;
const original = Object.fromEntries(B2_VARS.map((k) => [k, process.env[k]]));
beforeEach(() => {
  process.env.B2_KEY_ID = FAKE_KEY_ID;
  process.env.B2_APPLICATION_KEY = FAKE_SECRET;
  process.env.B2_BUCKET_NAME = BUCKET;
  process.env.B2_ENDPOINT = ENDPOINT;
  process.env.B2_REGION = "us-east-005";
});
afterAll(() => {
  for (const k of B2_VARS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
});

const USER = randomUUID();
const OTHER_USER = randomUUID();
const PNG_SOURCE = "https://g.tlcdn.com/gen/test.png";
const LIMITS = { maxBytes: 1024 * 1024 };

type CapturedPut = { path: string; body: Buffer; headers: Record<string, string> };
function captureB2Puts(status = 200) {
  const puts: CapturedPut[] = [];
  server.use(
    http.put(`${ENDPOINT}/${BUCKET}/*`, async ({ request }) => {
      puts.push({
        path: new URL(request.url).pathname,
        body: Buffer.from(await request.arrayBuffer()),
        headers: Object.fromEntries(request.headers.entries()),
      });
      return status === 200
        ? new HttpResponse(null, { status: 200, headers: { etag: '"abc"' } })
        : new HttpResponse(`<Error><Code>AccessDenied</Code><Message>denied</Message></Error>`, {
            status,
            headers: { "content-type": "application/xml" },
          });
    }),
  );
  return puts;
}

function serveSource(url: string, body: Buffer, headers: Record<string, string> = {}, status = 200) {
  server.use(
    http.get(url, () =>
      new HttpResponse(body, {
        status,
        headers: { "content-type": "image/png", "content-length": String(body.length), ...headers },
      }),
    ),
  );
}

describe("configuration", () => {
  it("fails lazily naming only the invalid variables, never any value", async () => {
    process.env.B2_ENDPOINT = "http://insecure.example";
    delete process.env.B2_KEY_ID;
    const err = await signedGetUrl(uploadObjectKey(USER, randomUUID(), "image/png"), USER).catch((e) => e);
    expect(err).toBeInstanceOf(StorageConfigError);
    expect(err.message).toContain("B2_KEY_ID");
    expect(err.message).toContain("B2_ENDPOINT");
    expect(err.message).not.toContain(FAKE_SECRET);
    expect(err.message).not.toContain("insecure.example");
  });

  it("does not touch the source when storage is unconfigured", async () => {
    delete process.env.B2_APPLICATION_KEY;
    let fetched = false;
    server.use(http.get(PNG_SOURCE, () => ((fetched = true), new HttpResponse("x"))));
    await expect(
      copyUrlToObject({ sourceUrl: PNG_SOURCE, key: uploadObjectKey(USER, randomUUID(), "image/png"), contentType: "image/png", limits: LIMITS }),
    ).rejects.toThrow(StorageConfigError);
    expect(fetched).toBe(false);
  });
});

describe("object keys and ownership", () => {
  it("namespaces keys by user and derives the extension from the verified type", () => {
    const id = randomUUID();
    expect(uploadObjectKey(USER, id, "image/jpeg")).toBe(`uploads/${USER}/${id}.jpg`);
    expect(generatedObjectKey(USER, id, 2, "video/mp4")).toBe(`generated/${USER}/${id}-2.mp4`);
  });

  it("rejects unsupported types and non-uuid identifiers (no user-controlled path segments)", () => {
    expect(() => uploadObjectKey(USER, randomUUID(), "application/x-msdownload")).toThrow();
    expect(() => uploadObjectKey("../../etc", randomUUID(), "image/png")).toThrow();
    expect(() => generatedObjectKey(USER, randomUUID(), -1, "image/png")).toThrow();
  });

  it("refuses to sign another user's object or a malformed key", async () => {
    const key = uploadObjectKey(USER, randomUUID(), "image/png");
    expect(() => assertKeyOwnedBy(key, USER)).not.toThrow();
    await expect(signedGetUrl(key, OTHER_USER)).rejects.toThrow(/does not belong/);
    await expect(signedGetUrl(`uploads/${USER}/../${OTHER_USER}/x.png`, USER)).rejects.toThrow();
  });
});

describe("signedGetUrl", () => {
  it("returns a path-style, short-lived SigV4 URL that never contains the application key", async () => {
    const key = uploadObjectKey(USER, randomUUID(), "image/png");
    const url = new URL(await signedGetUrl(key, USER));
    expect(`${url.origin}${url.pathname}`).toBe(`${ENDPOINT}/${BUCKET}/${key}`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
    expect(url.searchParams.get("X-Amz-Credential")).toContain("/us-east-005/s3/aws4_request");
    expect(url.toString()).not.toContain(FAKE_SECRET);
  });

  it("bounds the lifetime", async () => {
    const key = uploadObjectKey(USER, randomUUID(), "image/png");
    await expect(signedGetUrl(key, USER, 30)).rejects.toThrow(/between/);
    await expect(signedGetUrl(key, USER, 86_401)).rejects.toThrow(/between/);
    expect(new URL(await signedGetUrl(key, USER, 600)).searchParams.get("X-Amz-Expires")).toBe("600");
  });
});

describe("SSRF guard", () => {
  it.each([
    ["127.0.0.1"],
    ["10.1.2.3"],
    ["172.16.0.1"],
    ["192.168.1.1"],
    ["169.254.169.254"],
    ["100.64.0.1"],
    ["0.0.0.0"],
    ["::1"],
    ["fe80::1"],
    ["fc00::1"],
    ["::ffff:127.0.0.1"],
    ["64:ff9b::a00:1"],
    ["not-an-ip"],
  ])("treats %s as non-public", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([["8.8.8.8"], ["104.16.1.1"], ["2606:4700::1111"]])("treats %s as public", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  function lookupWith(addresses: LookupAddress[]) {
    const safe = createSafeLookup((_h, _o, cb) => cb(null, addresses));
    return new Promise<{ err: Error | null; result: unknown }>((resolve) =>
      safe("g.tlcdn.com", { all: true }, (err, result) => resolve({ err, result })),
    );
  }

  it("refuses to connect when DNS returns any private address (including mixed answers)", async () => {
    expect((await lookupWith([{ address: "10.0.0.5", family: 4 }])).err).toBeInstanceOf(SourceFetchError);
    expect((await lookupWith([{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }])).err).toBeInstanceOf(
      SourceFetchError,
    );
  });

  it("allows public answers", async () => {
    const { err, result } = await lookupWith([{ address: "104.16.1.1", family: 4 }]);
    expect(err).toBeNull();
    expect(result).toEqual([{ address: "104.16.1.1", family: 4 }]);
  });

  it("allowlists only verified storage hosts, exactly", () => {
    expect([...ALLOWED_SOURCE_HOSTS].sort()).toEqual([
      "g.tlcdn.com",
      "pub-e8fef8c0e03b44acb340577811800829.r2.dev",
      "static.magica.com",
    ]);
  });

  it.each([
    ["http://g.tlcdn.com/a.png", "NOT_HTTPS"],
    ["https://evil.example/a.png", "HOST_NOT_ALLOWED"],
    ["https://g.tlcdn.com.evil.example/a.png", "HOST_NOT_ALLOWED"],
    ["https://pub-other.r2.dev/a.png", "HOST_NOT_ALLOWED"],
    ["https://127.0.0.1/a.png", "HOST_NOT_ALLOWED"],
    ["https://user:pass@g.tlcdn.com/a.png", "HOST_NOT_ALLOWED"],
    ["https://g.tlcdn.com:8443/a.png", "HOST_NOT_ALLOWED"],
    ["not a url", "NOT_HTTPS"],
  ])("rejects %s before any request (%s)", async (url, reason) => {
    await expect(openSourceStream(url, LIMITS)).rejects.toMatchObject({ reason });
  });

  it("does not follow redirects", async () => {
    server.use(http.get(PNG_SOURCE, () => new HttpResponse(null, { status: 302, headers: { location: "http://169.254.169.254/" } })));
    await expect(openSourceStream(PNG_SOURCE, LIMITS)).rejects.toMatchObject({ reason: "REDIRECT" });
  });

  it("rejects non-200, missing length, and oversized sources", async () => {
    serveSource(PNG_SOURCE, Buffer.from("x"), {}, 404);
    await expect(openSourceStream(PNG_SOURCE, LIMITS)).rejects.toMatchObject({ reason: "HTTP_STATUS" });

    server.use(http.get(PNG_SOURCE, () => new HttpResponse(Readable.toWeb(Readable.from([Buffer.from("abc")])) as ReadableStream)));
    await expect(openSourceStream(PNG_SOURCE, LIMITS)).rejects.toMatchObject({ reason: "NO_LENGTH" });

    serveSource(PNG_SOURCE, Buffer.alloc(10), { "content-length": String(LIMITS.maxBytes + 1) });
    await expect(openSourceStream(PNG_SOURCE, LIMITS)).rejects.toMatchObject({ reason: "TOO_LARGE" });
  });

  it("times out a source that never responds", async () => {
    server.use(http.get(PNG_SOURCE, async () => (await delay("infinite"), new HttpResponse(null))));
    await expect(openSourceStream(PNG_SOURCE, { ...LIMITS, responseTimeoutMs: 100 })).rejects.toMatchObject({ reason: "TIMEOUT" });
  });
});

describe("streamed copy into B2", () => {
  it("streams the source into a private, path-style PUT with the verified type and exact length", async () => {
    const bytes = Buffer.alloc(256 * 1024, 7);
    serveSource(PNG_SOURCE, bytes);
    const puts = captureB2Puts();
    const key = generatedObjectKey(USER, randomUUID(), 0, "image/png");

    const result = await copyUrlToObject({ sourceUrl: PNG_SOURCE, key, contentType: "image/png", limits: LIMITS });

    expect(result).toEqual({ key, sizeBytes: bytes.length });
    expect(puts).toHaveLength(1);
    expect(puts[0].path).toBe(`/${BUCKET}/${key}`);
    expect(puts[0].body.equals(bytes)).toBe(true);
    expect(puts[0].headers["content-type"]).toBe("image/png");
    expect(puts[0].headers["content-length"]).toBe(String(bytes.length));
    expect(puts[0].headers["x-amz-acl"]).toBeUndefined();
    expect(puts[0].headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=/);
    expect(JSON.stringify(puts[0].headers)).not.toContain(FAKE_SECRET);
  });

  it("surfaces a B2 rejection as a retriable error that carries no credentials", async () => {
    serveSource(PNG_SOURCE, Buffer.from("png"));
    captureB2Puts(403);
    const err = await copyUrlToObject({
      sourceUrl: PNG_SOURCE,
      key: uploadObjectKey(USER, randomUUID(), "image/png"),
      contentType: "image/png",
      limits: LIMITS,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(StorageUnavailableError);
    expect(err.statusCode).toBe(403);
    expect(err.message).not.toContain(FAKE_SECRET);
    expect(err.message).not.toContain(FAKE_KEY_ID);
  });

  it("does not upload anything when the source is rejected", async () => {
    const puts = captureB2Puts();
    await expect(
      copyUrlToObject({
        sourceUrl: "https://evil.example/a.png",
        key: uploadObjectKey(USER, randomUUID(), "image/png"),
        contentType: "image/png",
        limits: LIMITS,
      }),
    ).rejects.toBeInstanceOf(SourceFetchError);
    expect(puts).toHaveLength(0);
  });

  it("aborts the upload, without hanging, when the source stalls after sending headers", async () => {
    serveSource(PNG_SOURCE, Buffer.from("short"), { "content-length": "100" });
    captureB2Puts();
    await expect(
      copyUrlToObject({
        sourceUrl: PNG_SOURCE,
        key: uploadObjectKey(USER, randomUUID(), "image/png"),
        contentType: "image/png",
        limits: { ...LIMITS, idleTimeoutMs: 200 },
      }),
    ).rejects.toBeInstanceOf(SourceFetchError);
  }, 5000);

  it("aborts the upload when the B2 body stream errors mid-transfer", async () => {
    captureB2Puts();
    const body = new Readable({ read() {} });
    const pending = putObjectStream({
      key: uploadObjectKey(USER, randomUUID(), "image/png"),
      body,
      contentLength: 1000,
      contentType: "image/png",
    });
    body.push(Buffer.alloc(10));
    body.destroy(new SourceFetchError("NETWORK", "Source stream failed"));
    await expect(pending).rejects.toMatchObject({ reason: "NETWORK" });
  }, 5000);

  it("refuses to write to a key outside the storage layout", async () => {
    await expect(
      putObjectStream({ key: "../escape.png", body: Readable.from([Buffer.from("x")]), contentLength: 1, contentType: "image/png" }),
    ).rejects.toThrow(/Invalid object key/);
  });
});
