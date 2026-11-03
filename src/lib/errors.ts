import { ZodError } from "zod";
import type { ErrorResponse } from "@/contracts/common";
import { Prisma } from "@/generated/prisma/client";

/** Prisma P2028 "Unable to start a transaction in the given time" (pool saturated). */
function isPoolSaturated(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2028" &&
    error.message.includes("Unable to start a transaction")
  );
}

/** Missing or invalid bearer token. Always maps to 401. */
export class UnauthorizedError extends Error {
  constructor(message = "Authentication required") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/** A resource doesn't exist, OR exists but isn't owned by the caller — the
 * two cases are deliberately indistinguishable from the response, so a 404
 * never leaks whether someone else's resource exists. */
export class NotFoundError extends Error {
  constructor(message = "Not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends Error {
  constructor(
    message = "Invalid request",
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

/** A request that's otherwise valid conflicts with the current state of
 * the resource — e.g. a chat already has an active run. The client can
 * retry later or act on the existing state; it isn't a validation
 * failure or an ownership issue. */
export class ConflictError extends Error {
  constructor(message = "Conflict") {
    super(message);
    this.name = "ConflictError";
  }
}

/** The run's execution has ended for good, so a pending decision can't be
 * applied; the run was stopped (RUN_INTERRUPTED). Not retryable. */
export class RunInterruptedError extends Error {
  constructor(message = "This run stopped unexpectedly, so the decision can't be applied. Send a new message to continue.") {
    super(message);
    this.name = "RunInterruptedError";
  }
}

/** The execution's state couldn't be confirmed; nothing was changed. Retryable. */
export class ExecutionStatusUnavailableError extends Error {
  constructor(message = "We couldn't confirm the run is still waiting for you. Nothing was changed — try again in a moment.") {
    super(message);
    this.name = "ExecutionStatusUnavailableError";
  }
}

const STATUS_BY_ERROR_NAME: Record<string, number> = {
  UnauthorizedError: 401,
  NotFoundError: 404,
  ValidationError: 400,
  ConflictError: 409,
  TransloaditConfigError: 503,
  TransloaditUnavailableError: 502,
  UploadArchiveError: 502,
  UploadStorageUnavailableError: 503,
  AttachmentUrlUnavailableError: 500,
  WaitpointResumeError: 503,
  RunInterruptedError: 409,
  ExecutionStatusUnavailableError: 503,
};

/** Maps a thrown error to a safe, non-leaking HTTP response. Anything not
 * one of our typed errors becomes a generic 500 with no internal detail —
 * never a stack trace or a driver error message reaches the client. */
export function toErrorResponse(error: unknown): {
  status: number;
  body: ErrorResponse;
} {
  // A raw ZodError (every route's `.parse()` call on a body/query throws
  // this directly — there's no reason to wrap each one in a try/catch
  // that rethrows ValidationError) maps to 400. The per-field issue list
  // is safe, actionable feedback the client needs — "title: too short" is
  // not an internal detail — unlike a stack trace or driver error.
  if (error instanceof ZodError) {
    const issues = error.issues
      .map((issue) => `${issue.path.join(".") || "(body)"}: ${issue.message}`)
      .join("; ");
    return {
      status: 400,
      body: {
        ok: false,
        error: { code: "ValidationError", message: issues || "Invalid request" },
      },
    };
  }

  // Overload, not a fault: every pooled connection was busy for the whole
  // transaction wait. Nothing was written (the transaction never started),
  // so the request is safe to retry.
  if (isPoolSaturated(error)) {
    return {
      status: 503,
      body: { ok: false, error: { code: "ServiceBusy", message: "The service is busy. Try again in a moment." } },
    };
  }

  if (error instanceof Error && error.name in STATUS_BY_ERROR_NAME) {
    return {
      status: STATUS_BY_ERROR_NAME[error.name],
      body: {
        ok: false,
        error: { code: error.name, message: error.message },
      },
    };
  }

  // TODO(structured-logging): replace with the pino adapter once wired in.
  console.error("Unhandled error in route handler:", error);
  return {
    status: 500,
    body: { ok: false, error: { code: "InternalError", message: "Something went wrong" } },
  };
}
