import { withRoute, routeOptions, parseJsonBody } from "@/lib/route-handler";
import { CompletionRequestSchema } from "@/contracts/completion";
import { ValidationError } from "@/lib/errors";
import { createCompletion } from "@/services/completion";

export const OPTIONS = routeOptions;

/** Chat-style completion: submits a turn (new or existing chat) and returns the run to follow. */
export const POST = withRoute<Record<string, never>, unknown>(
  async ({ request, auth }) => {
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey) throw new ValidationError("Idempotency-Key header is required");
    return createCompletion(auth.userId, idempotencyKey, await parseJsonBody(request, CompletionRequestSchema));
  },
  { status: 202 },
);
