import { withRoute, routeOptions, parseJsonBody } from "@/lib/route-handler";
import { ToolRunRequestSchema } from "@/contracts/tool-run";
import { ValidationError } from "@/lib/errors";
import { submitToolRun } from "@/services/tool-run";

export const OPTIONS = routeOptions;

/** Runs one Magica tool directly (no model). Poll the returned run; results arrive as a message. */
export const POST = withRoute<{ chatId: string }, unknown>(
  async ({ request, auth, params }) => {
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey) throw new ValidationError("Idempotency-Key header is required");
    return submitToolRun(auth.userId, params.chatId, idempotencyKey, await parseJsonBody(request, ToolRunRequestSchema));
  },
  { status: 202 },
);
