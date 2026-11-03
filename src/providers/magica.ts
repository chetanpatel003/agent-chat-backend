import { z } from "zod";

// Base URL, status set, and field list all confirmed against the
// official Magica docs during the Phase 3 discovery checkpoints — see
// project-docs/magica/EXECUTION_API.md. Nothing here is guessed: the
// start endpoint's `{runId}` 202 shape, the poll endpoint's field list,
// and the documented status values are copied from that investigation,
// not re-derived. No model has been executed against this adapter —
// checkpoint 3.2 builds the plumbing only; no production tool uses it
// yet (see src/tools/registry.ts — Crop Image/GPT Image 2/Merge Videos
// are explicitly deferred).

const DEFAULT_BASE_URL = "https://inference.magica.com";
const REQUEST_TIMEOUT_MS = 30_000;

function baseUrl(): string {
  return process.env.MAGICA_BASE_URL || DEFAULT_BASE_URL;
}

// Never logged, never included in any error message or thrown value —
// read once per call, used only in the Authorization header.
function apiKey(): string {
  const key = process.env.MAGICA_API_KEY;
  if (!key) {
    throw new MagicaDefiniteError("MAGICA_API_KEY is not configured", "MISSING_API_KEY");
  }
  return key;
}

/** A definitive outcome: Magica told us something (success or a clear
 * rejection), or we rejected the request before sending it. Safe to
 * finalize immediately. Mirrors OpenRouterDefiniteError's shape
 * (src/providers/openrouter.ts) exactly, for the same reason. */
export class MagicaDefiniteError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "MagicaDefiniteError";
  }
}

/** We do not know whether Magica received/started the run — our own
 * timeout fired, the connection was reset after the request may have
 * already been transmitted, or Magica returned a 5xx (which does not
 * prove the backend never enqueued the job, only that we didn't get a
 * clean answer). Never treated as proof of "nothing happened"; the
 * caller must never automatically retry a start request on this. */
export class MagicaAmbiguousError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "MagicaAmbiguousError";
  }
}

/** Thrown by `services/magica-run.ts`'s polling/reconciliation
 * functions to mean "this run's outcome genuinely cannot be
 * determined right now" — a bounded polling budget was exhausted, the
 * local AgentRun stopped being RUNNING (cancellation), or no
 * `providerRunId` was ever persisted to reconcile against. Never a
 * failure signal: the caller (`run-agent-turn.ts`) recognizes this
 * specific type and leaves the ToolInvocation exactly as it was
 * (RUNNING, `providerRunId` intact if present) rather than persisting
 * FAILED — a later re-entry's `reconcile()` call can pick up where
 * this one left off. */
export class MagicaPollInconclusiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MagicaPollInconclusiveError";
  }
}

const StartRunResponseSchema = z.object({ runId: z.string().min(1) });

export type MagicaStartedRun = { runId: string };

/**
 * `POST /v1/nodes/{nodeType}/run`. Throws `MagicaDefiniteError` for an
 * outcome we can finalize immediately (missing config, a 4xx/429 — a
 * request-level rejection that, per convention, Magica's docs don't
 * explicitly confirm happens before any job is enqueued, but retrying
 * a bad request wouldn't help regardless), or `MagicaAmbiguousError`
 * for anything that does NOT rule out the run having started: a 5xx
 * (can occur after the backend already enqueued the job), or a network
 * failure that isn't provably pre-transmission (see
 * `classifyNetworkError` below) — callers must never treat either as
 * safe to retry with a second start request.
 */
export async function startMagicaRun(
  nodeType: string,
  input: Record<string, unknown>,
  subModelId?: string,
): Promise<MagicaStartedRun> {
  const key = apiKey();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${baseUrl()}/v1/nodes/${nodeType}/run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ input, ...(subModelId ? { subModelId } : {}) }),
      signal: controller.signal,
    });
  } catch (error) {
    throw classifyNetworkError(error, "start");
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw classifyHttpStatus(response.status, "start");
  }

  const body: unknown = await response.json().catch(() => null);
  const parsed = StartRunResponseSchema.safeParse(body);
  if (!parsed.success) {
    // A 202 was returned — per the documented API this means Magica
    // accepted and started the run — but the body didn't give us a
    // usable runId. This is NOT "nothing happened"; it's the same
    // untrackable-but-probably-started situation as losing the
    // response entirely. Ambiguous, never retry.
    throw new MagicaAmbiguousError(
      "Magica returned 202 but the response body did not contain a usable runId",
      "MAGICA_START_RESPONSE_MALFORMED",
    );
  }

  return { runId: parsed.data.runId };
}

// Magica's own docs hedge the status list with "such as" — the set
// below is what's documented, not asserted to be exhaustive. See
// run-agent-turn.ts/magica-run.ts callers for how an unrecognized
// value is handled (kept polling, never silently mapped to
// FAILED/COMPLETED).
export const MAGICA_TERMINAL_STATUSES = ["COMPLETED", "FAILED", "CANCELED"] as const;
export const MAGICA_PENDING_STATUSES = ["QUEUED", "RUNNING"] as const;

const GetRunResponseSchema = z.object({
  id: z.string(),
  nodeType: z.string(),
  // Intentionally a plain string, not a z.enum of the documented
  // values — rejecting an unrecognized status at the schema layer
  // would be exactly the "silently discard" item 3 forbids; the
  // schema's job here is just "is this shaped like a poll response,"
  // not "is the status one we already know about."
  status: z.string(),
  createdAt: z.string(),
  subModelId: z.string().nullable().optional(),
  input: z.unknown().optional(),
  output: z.unknown().nullable().optional(),
  error: z.string().nullable().optional(),
  userMessage: z.string().nullable().optional(),
  creditUsed: z.number().optional(),
  source: z.string().nullable().optional(),
});

export type MagicaRunPoll = z.infer<typeof GetRunResponseSchema>;

/**
 * `GET /v1/nodes/runs/{runId}`. Unlike `startMagicaRun`, every failure
 * mode here — network error, timeout, non-200 status, a malformed
 * body — throws the same `MagicaAmbiguousError`-shaped signal, because
 * polling an *already-started* run is safe to retry regardless of why
 * one attempt failed (it's a GET against a run that is known to
 * exist); the caller (`services/magica-run.ts`) treats every throw
 * from this function as "transient, try the poll again," never as a
 * reason to fail the underlying run or start a new one.
 */
export async function getMagicaRun(runId: string): Promise<MagicaRunPoll> {
  const key = apiKey();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${baseUrl()}/v1/nodes/runs/${runId}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
  } catch (error) {
    throw new MagicaAmbiguousError(
      error instanceof Error ? error.message : "Network error polling Magica",
      "MAGICA_POLL_TRANSIENT",
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new MagicaAmbiguousError(`Magica poll returned HTTP ${response.status}`, "MAGICA_POLL_TRANSIENT");
  }

  const body: unknown = await response.json().catch(() => null);
  const parsed = GetRunResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new MagicaAmbiguousError("Magica poll response did not match the expected shape", "MAGICA_POLL_TRANSIENT");
  }
  return parsed.data;
}

/**
 * Distinguishes a network failure that can be *reliably established*
 * as pre-transmission (the connection itself never completed — DNS
 * failure, connection refused) from everything else. Only the former
 * is safe to treat as "Magica never saw this request"; per the task's
 * own instruction, this is not assumed for a generic fetch failure —
 * Node's `fetch` attaches a low-level `cause.code` for exactly the
 * handful of error classes where the OS can tell us the TCP handshake
 * itself never completed. An AbortError (our own timeout) or
 * ECONNRESET (the connection died after it was established — bytes
 * may already be in flight or Magica may already be processing) are
 * explicitly NOT in this list.
 */
const PRE_TRANSMISSION_ERROR_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

function classifyNetworkError(error: unknown, phase: "start"): MagicaDefiniteError | MagicaAmbiguousError {
  const cause = error instanceof Error && "cause" in error ? (error.cause as { code?: string } | undefined) : undefined;
  const code = cause?.code;
  if (code && PRE_TRANSMISSION_ERROR_CODES.has(code)) {
    return new MagicaDefiniteError(
      `Could not establish a connection to Magica before sending the ${phase} request (${code})`,
      "MAGICA_START_NOT_SENT",
    );
  }
  // Everything else — our own AbortController timeout, ECONNRESET, or
  // any network failure without a recognized pre-transmission code —
  // cannot be proven to have happened before Magica received the
  // request.
  return new MagicaAmbiguousError(
    error instanceof Error ? error.message : `Network error during Magica ${phase} request`,
    "MAGICA_START_AMBIGUOUS_NETWORK",
  );
}

function classifyHttpStatus(status: number, phase: "start"): MagicaDefiniteError | MagicaAmbiguousError {
  if (status >= 500) {
    // A 5xx does not prove the backend never enqueued the job —
    // explicitly not treated as "definitely did not start."
    return new MagicaAmbiguousError(`Magica ${phase} returned HTTP ${status}`, "MAGICA_START_AMBIGUOUS_5XX");
  }
  if (status === 429) {
    return new MagicaDefiniteError(`Magica ${phase} request was rate-limited`, "RATE_LIMITED");
  }
  return new MagicaDefiniteError(`Magica ${phase} request was rejected (HTTP ${status})`, "MAGICA_START_REJECTED");
}

// ---------- Credit estimate (no run, no charge) ----------
// `POST /v1/nodes/estimate-credits`: "Pricing uses the same rules as
// run-time billing, without starting a run or charging credits." Returns
// raw integer `microcredits` — the same unit as a run's `creditUsed` and
// the account balance (see project-docs/magica/CREDIT_ACCOUNTING.md).

export type EstimateNode = { type: string; subModelId?: string; data?: Record<string, unknown> };

const EstimateResponseSchema = z.object({
  estimates: z.array(z.object({ microcredits: z.number().int().nonnegative() })).min(1),
});

/** Estimates one node's raw credit cost. Any network/HTTP/shape problem is a
 * MagicaDefiniteError("MAGICA_ESTIMATE_UNAVAILABLE"): callers fail closed. */
export async function estimateNodeCredits(node: EstimateNode): Promise<bigint> {
  const key = apiKey();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}/v1/nodes/estimate-credits`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ nodes: [node] }),
      signal: controller.signal,
    });
  } catch {
    throw new MagicaDefiniteError("Magica credit estimate could not be reached", "MAGICA_ESTIMATE_UNAVAILABLE");
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new MagicaDefiniteError(`Magica credit estimate failed (HTTP ${response.status})`, "MAGICA_ESTIMATE_UNAVAILABLE");
  }
  const parsed = EstimateResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new MagicaDefiniteError("Magica credit estimate had an unexpected shape", "MAGICA_ESTIMATE_UNAVAILABLE");
  }
  return BigInt(parsed.data.estimates[0].microcredits);
}
