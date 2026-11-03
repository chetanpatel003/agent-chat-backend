import dns, { type LookupAddress, type LookupAllOptions } from "node:dns";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { Transform, type Readable } from "node:stream";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { z } from "zod";

// Backblaze B2 through its S3-compatible API. Objects are private (no ACL
// is ever set); reads go through short-lived presigned GET URLs. Bytes
// live in B2, keys/metadata in PostgreSQL. No other storage provider.

// ---------- Configuration (validated lazily, values never echoed) ----------

const B2EnvSchema = z.object({
  B2_KEY_ID: z.string().min(1),
  B2_APPLICATION_KEY: z.string().min(1),
  // B2 bucket names: 6–50 letters, digits, hyphens.
  B2_BUCKET_NAME: z.string().regex(/^[A-Za-z0-9-]{6,50}$/),
  B2_ENDPOINT: z.url({ protocol: /^https$/ }),
  B2_REGION: z.string().min(1),
});

export class StorageConfigError extends Error {
  constructor(invalidVariables: string[]) {
    super(`Object storage is not configured (invalid or missing: ${invalidVariables.join(", ")})`);
    this.name = "StorageConfigError";
  }
}

/** B2 rejected or could not be reached. Retriable; carries no credentials. */
export class StorageUnavailableError extends Error {
  constructor(public readonly statusCode: number | undefined, code: string) {
    super(`Object storage request failed (${code}${statusCode ? `, HTTP ${statusCode}` : ""})`);
    this.name = "StorageUnavailableError";
  }
}

let cached: { fingerprint: string; client: S3Client; bucket: string } | null = null;

function storage() {
  const parsed = B2EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new StorageConfigError([...new Set(parsed.error.issues.map((i) => String(i.path[0])))]);
  }
  const env = parsed.data;
  const fingerprint = [env.B2_KEY_ID, env.B2_APPLICATION_KEY, env.B2_BUCKET_NAME, env.B2_ENDPOINT, env.B2_REGION].join("\n");
  if (cached?.fingerprint !== fingerprint) {
    cached = {
      fingerprint,
      bucket: env.B2_BUCKET_NAME,
      client: new S3Client({
        endpoint: env.B2_ENDPOINT,
        region: env.B2_REGION,
        credentials: { accessKeyId: env.B2_KEY_ID, secretAccessKey: env.B2_APPLICATION_KEY },
        // Bucket names with uppercase letters are not valid hostnames.
        forcePathStyle: true,
        // Only send checksums S3 strictly requires: avoids aws-chunked
        // encoding/CRC trailers that S3-compatible stores may reject.
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
        // A streamed body cannot be replayed; callers retry the whole copy.
        maxAttempts: 1,
      }),
    };
  }
  return { client: cached.client, bucket: cached.bucket };
}

// ---------- Object keys (never derived from user-supplied names) ----------

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const KEY_PATTERN = new RegExp(`^(uploads|generated)/(${UUID})/${UUID}(-\\d+)?\\.(png|jpg|webp|mp4|mov|webm)$`);
const UUID_PATTERN = new RegExp(`^${UUID}$`);

function extensionFor(mimeType: string): string {
  const ext = EXTENSION_BY_MIME[mimeType];
  if (!ext) throw new Error(`Unsupported storage type: ${mimeType}`);
  return ext;
}

function requireUuid(value: string, label: string) {
  if (!UUID_PATTERN.test(value)) throw new Error(`Invalid ${label}`);
}

export function uploadObjectKey(userId: string, attachmentId: string, mimeType: string): string {
  requireUuid(userId, "userId");
  requireUuid(attachmentId, "attachmentId");
  return `uploads/${userId}/${attachmentId}.${extensionFor(mimeType)}`;
}

export function generatedObjectKey(userId: string, toolInvocationId: string, index: number, mimeType: string): string {
  requireUuid(userId, "userId");
  requireUuid(toolInvocationId, "toolInvocationId");
  if (!Number.isInteger(index) || index < 0) throw new Error("Invalid index");
  return `generated/${userId}/${toolInvocationId}-${index}.${extensionFor(mimeType)}`;
}

/** Defense in depth: a key is only ever signed for the user it is namespaced under. */
export function assertKeyOwnedBy(key: string, userId: string): void {
  const match = KEY_PATTERN.exec(key);
  if (!match || match[2] !== userId) throw new Error("Object key does not belong to this user");
}

// ---------- Source fetching (SSRF-guarded) ----------

/** Exact hosts observed serving real Transloadit / Magica results in
 * this project (database + live verification). No wildcards: `*.r2.dev`
 * would admit any account's public R2 bucket. */
export const ALLOWED_SOURCE_HOSTS: ReadonlySet<string> = new Set([
  "pub-e8fef8c0e03b44acb340577811800829.r2.dev", // Transloadit temporary storage
  "g.tlcdn.com", // Magica generated outputs
  "static.magica.com", // Magica generated outputs
]);

export type SourceFetchReason =
  | "NOT_HTTPS"
  | "HOST_NOT_ALLOWED"
  | "PRIVATE_ADDRESS"
  | "REDIRECT"
  | "HTTP_STATUS"
  | "NO_LENGTH"
  | "TOO_LARGE"
  | "LENGTH_MISMATCH"
  | "TIMEOUT"
  | "NETWORK";

export class SourceFetchError extends Error {
  constructor(
    public readonly reason: SourceFetchReason,
    message: string,
  ) {
    super(message);
    this.name = "SourceFetchError";
  }
}

const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv6");
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !BLOCKED.check(address, "ipv4");
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return !BLOCKED.check(mapped[1], "ipv4");
    return !BLOCKED.check(address, "ipv6");
  }
  return false;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;
type Resolver = (hostname: string, options: LookupAllOptions, cb: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

/** A `lookup` for https.request that refuses to connect to any
 * non-public address — checked on the address actually connected to,
 * so DNS rebinding between check and connect is not possible. */
export function createSafeLookup(resolve?: Resolver) {
  return (hostname: string, options: { all?: boolean; family?: number }, callback: LookupCallback) => {
    // Resolved at call time (not import time) so it stays patchable.
    (resolve ?? (dns.lookup as unknown as Resolver))(hostname, { ...options, all: true } as LookupAllOptions, (err, addresses) => {
      if (err) return callback(err, []);
      if (addresses.length === 0 || addresses.some((a) => !isPublicAddress(a.address))) {
        return callback(Object.assign(new SourceFetchError("PRIVATE_ADDRESS", "Source resolves to a non-public address"), { code: "EPRIVATE" }), []);
      }
      if (options.all) return callback(null, addresses);
      return callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

export type SourceFetchLimits = {
  maxBytes: number;
  connectTimeoutMs?: number;
  responseTimeoutMs?: number;
  idleTimeoutMs?: number;
};

export type SourceStream = { body: Readable; contentLength: number; contentType: string | null };

function validateSourceUrl(sourceUrl: string): URL {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw new SourceFetchError("NOT_HTTPS", "Source is not a valid URL");
  }
  if (url.protocol !== "https:") throw new SourceFetchError("NOT_HTTPS", "Source must use https");
  if (url.username || url.password || (url.port && url.port !== "443")) {
    throw new SourceFetchError("HOST_NOT_ALLOWED", "Source URL form is not allowed");
  }
  if (!ALLOWED_SOURCE_HOSTS.has(url.hostname)) throw new SourceFetchError("HOST_NOT_ALLOWED", "Source host is not allowed");
  return url;
}

/**
 * Opens a streamed GET to an allowlisted HTTPS source. Redirects are never
 * followed. Requires Content-Length (needed to stream into a single PUT)
 * and enforces it, plus `maxBytes`, while bytes flow.
 */
export async function openSourceStream(
  sourceUrl: string,
  limits: SourceFetchLimits,
  lookup = createSafeLookup(),
): Promise<SourceStream> {
  const url = validateSourceUrl(sourceUrl);
  const { maxBytes, connectTimeoutMs = 10_000, responseTimeoutMs = 30_000, idleTimeoutMs = 30_000 } = limits;

  return new Promise((resolve, reject) => {
    let settled = false;
    // Set once headers are accepted; later failures must kill the body stream.
    let bodyStream: Transform | null = null;
    const fail = (error: Error) => {
      if (bodyStream) {
        bodyStream.destroy(error);
        req.destroy();
        return;
      }
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(responseTimer);
      req.destroy();
      reject(error);
    };

    const req = https.request(url, {
      method: "GET",
      lookup: lookup as never,
      agent: false,
      headers: { "accept-encoding": "identity", "user-agent": "agent-chat-backend" },
    });

    const connectTimer = setTimeout(() => fail(new SourceFetchError("TIMEOUT", "Source connection timed out")), connectTimeoutMs);
    const responseTimer = setTimeout(() => fail(new SourceFetchError("TIMEOUT", "Source response timed out")), responseTimeoutMs);

    req.on("socket", (socket) => {
      if (!socket.connecting) clearTimeout(connectTimer);
      else socket.once("connect", () => clearTimeout(connectTimer));
    });
    req.setTimeout(idleTimeoutMs, () => fail(new SourceFetchError("TIMEOUT", "Source stalled")));
    req.on("error", (error) =>
      fail(error instanceof SourceFetchError ? error : new SourceFetchError("NETWORK", "Could not reach source")),
    );

    req.on("response", (res) => {
      clearTimeout(connectTimer);
      clearTimeout(responseTimer);
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) return fail(new SourceFetchError("REDIRECT", "Source redirects are not followed"));
      if (status !== 200) return fail(new SourceFetchError("HTTP_STATUS", `Source returned HTTP ${status}`));
      const declared = Number(res.headers["content-length"]);
      if (!res.headers["content-length"] || !Number.isSafeInteger(declared) || declared < 0) {
        return fail(new SourceFetchError("NO_LENGTH", "Source did not declare a content length"));
      }
      if (declared > maxBytes) return fail(new SourceFetchError("TOO_LARGE", "Source is larger than allowed"));

      let seen = 0;
      const guard = new Transform({
        transform(chunk: Buffer, _enc, done) {
          seen += chunk.length;
          if (seen > declared || seen > maxBytes) {
            return done(new SourceFetchError("LENGTH_MISMATCH", "Source sent more bytes than declared"));
          }
          done(null, chunk);
        },
        flush(done) {
          done(seen === declared ? null : new SourceFetchError("LENGTH_MISMATCH", "Source ended early"));
        },
      });
      res.on("error", (e) => guard.destroy(e instanceof SourceFetchError ? e : new SourceFetchError("NETWORK", "Source stream failed")));
      res.on("aborted", () => guard.destroy(new SourceFetchError("NETWORK", "Source connection closed early")));
      guard.on("error", () => req.destroy());
      bodyStream = guard;
      settled = true;
      resolve({
        body: res.pipe(guard),
        contentLength: declared,
        contentType: typeof res.headers["content-type"] === "string" ? res.headers["content-type"] : null,
      });
    });

    req.end();
  });
}

// ---------- B2 operations ----------

function toStorageError(error: unknown): StorageUnavailableError {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return new StorageUnavailableError(e?.$metadata?.httpStatusCode, e?.name ?? "UnknownError");
}

/** Streams a body of known length into a private object. */
export async function putObjectStream(params: {
  key: string;
  body: Readable;
  contentLength: number;
  contentType: string;
}): Promise<void> {
  if (!KEY_PATTERN.test(params.key)) throw new Error("Invalid object key");
  const { client, bucket } = storage();
  // A failing source must abort the in-flight PUT rather than leave it hanging.
  const abort = new AbortController();
  let bodyError: Error | null = null;
  params.body.once("error", (error) => {
    bodyError = error;
    abort.abort();
  });
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: params.key,
        Body: params.body,
        ContentLength: params.contentLength,
        ContentType: params.contentType,
      }),
      { abortSignal: abort.signal },
    );
  } catch (error) {
    params.body.destroy();
    if (bodyError) throw bodyError;
    throw toStorageError(error);
  }
}

/** Copies an allowlisted HTTPS source into B2 without buffering it. */
export async function copyUrlToObject(params: {
  sourceUrl: string;
  key: string;
  contentType: string;
  limits: SourceFetchLimits;
}): Promise<{ key: string; sizeBytes: number }> {
  storage(); // fail fast on configuration before touching the source
  const source = await openSourceStream(params.sourceUrl, params.limits);
  await putObjectStream({ key: params.key, body: source.body, contentLength: source.contentLength, contentType: params.contentType });
  return { key: params.key, sizeBytes: source.contentLength };
}

/**
 * The object key behind one of our own (path-style) B2 URLs —
 * `<B2_ENDPOINT>/<bucket>/<key>?…` as signedGetUrl produces — or null for
 * any other URL. Pure parsing: it neither checks the signature nor grants
 * access; callers must still check ownership (e.g. the attachment row's
 * userId) before trusting the key.
 */
export function storageKeyFromUrl(value: string): string | null {
  const endpoint = process.env.B2_ENDPOINT;
  const bucket = process.env.B2_BUCKET_NAME;
  if (!endpoint || !bucket) return null;
  let url: URL;
  let base: URL;
  try {
    url = new URL(value);
    base = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.origin !== base.origin) return null;
  const prefix = `/${bucket}/`;
  if (!url.pathname.startsWith(prefix)) return null;
  let key: string;
  try {
    key = decodeURIComponent(url.pathname.slice(prefix.length));
  } catch {
    return null;
  }
  return KEY_PATTERN.test(key) ? key : null;
}

export const SIGNED_URL_DEFAULT_TTL_SECONDS = 3600;

/** Short-lived, read-only URL for one private object owned by `ownerUserId`. */
export async function signedGetUrl(
  key: string,
  ownerUserId: string,
  expiresInSeconds = SIGNED_URL_DEFAULT_TTL_SECONDS,
): Promise<string> {
  assertKeyOwnedBy(key, ownerUserId);
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 60 || expiresInSeconds > 86_400) {
    throw new Error("Signed URL lifetime must be between 60 seconds and 24 hours");
  }
  const { client, bucket } = storage();
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: expiresInSeconds });
}
