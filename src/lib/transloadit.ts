import { createHmac } from "node:crypto";
import { z } from "zod";
import { AssemblyIdSchema } from "@/contracts/attachment";

// Signing per https://transloadit.com/docs/api/authentication/: an HMAC
// hex digest of the exact serialized `params` string, keyed with the
// Auth Secret and prefixed "sha384:" (the default algorithm for keys).
// Only the `:original` upload is kept — no processing steps — so the
// Community plan's watermarking/trimming of *results* never touches the
// file, and no paid feature can be invoked.

const STATUS_BASE_URL = "https://api2.transloadit.com/assemblies/";
const STATUS_TIMEOUT_MS = 15_000;
export const UPLOAD_AUTH_TTL_MS = 30 * 60 * 1000;

export class TransloaditConfigError extends Error {
  constructor() {
    super("Uploads are not configured on this server");
    this.name = "TransloaditConfigError";
  }
}

/** Status could not be fetched (network/HTTP) — retriable, not a verdict on the upload. */
export class TransloaditUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransloaditUnavailableError";
  }
}

function credentials() {
  const key = process.env.TRANSLOADIT_KEY;
  const secret = process.env.TRANSLOADIT_SECRET;
  if (!key || !secret) throw new TransloaditConfigError();
  return { key, secret };
}

export function signParams(params: string, secret: string): string {
  return `sha384:${createHmac("sha384", secret).update(params, "utf8").digest("hex")}`;
}

/**
 * Signed Assembly instructions for one upload. `nonce` is part of the
 * signed params and is echoed back in the Assembly status, which is how
 * completion proves the Assembly was created from this authorization.
 */
export function createUploadAuthorization(nonce: string, now = new Date()) {
  const { key, secret } = credentials();
  const expiresAt = new Date(now.getTime() + UPLOAD_AUTH_TTL_MS);
  const params = JSON.stringify({
    auth: { key, expires: expiresAt.toISOString() },
    nonce,
    steps: { ":original": { robot: "/upload/handle" } },
  });
  return { params, signature: signParams(params, secret), expiresAt: expiresAt.toISOString() };
}

const UploadSchema = z.object({
  mime: z.string(),
  size: z.number().int().nonnegative(),
  ssl_url: z.string(),
  original_name: z.string().optional(),
  meta: z
    .object({
      width: z.number().nullish(),
      height: z.number().nullish(),
      duration: z.number().nullish(),
    })
    .partial()
    .nullish(),
});

const AssemblyStatusSchema = z.object({
  assembly_id: z.string(),
  ok: z.string().optional(),
  error: z.string().optional(),
  params: z.string().optional(),
  uploads: z.array(UploadSchema).optional(),
});
export type AssemblyStatus = z.infer<typeof AssemblyStatusSchema>;
export type AssemblyUpload = z.infer<typeof UploadSchema>;

/** Reads an Assembly's status straight from Transloadit (a public,
 * id-addressed endpoint — never a client-supplied URL). */
export async function fetchAssemblyStatus(assemblyId: string): Promise<AssemblyStatus | null> {
  const id = AssemblyIdSchema.parse(assemblyId);
  let response: Response;
  try {
    response = await fetch(`${STATUS_BASE_URL}${id}`, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
  } catch {
    throw new TransloaditUnavailableError("Could not reach Transloadit");
  }
  if (response.status >= 500) throw new TransloaditUnavailableError(`Transloadit returned HTTP ${response.status}`);
  const body: unknown = await response.json().catch(() => null);
  const parsed = AssemblyStatusSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

/** The signed nonce echoed in a status's `params` JSON, if any. */
export function nonceFromStatus(status: AssemblyStatus): string | null {
  if (!status.params) return null;
  try {
    const params = JSON.parse(status.params) as { nonce?: unknown };
    return typeof params.nonce === "string" ? params.nonce : null;
  } catch {
    return null;
  }
}
