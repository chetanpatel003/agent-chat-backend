import { ZodError } from "zod";
import type { ErrorResponse } from "@/contracts/common";

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

const STATUS_BY_ERROR_NAME: Record<string, number> = {
  UnauthorizedError: 401,
  NotFoundError: 404,
  ValidationError: 400,
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
