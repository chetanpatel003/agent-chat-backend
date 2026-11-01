import { withRoute, routeOptions, parseSearchParams, parseJsonBody } from "@/lib/route-handler";
import { CursorPaginationRequestSchema } from "@/contracts/pagination";
import { SendMessageRequestSchema } from "@/contracts/message";
import { ValidationError } from "@/lib/errors";
import { listMessages } from "@/services/message";
import { sendTurn } from "@/services/send-turn";

export const OPTIONS = routeOptions;

export const GET = withRoute<{ chatId: string }, unknown>(
  async ({ request, auth, params }) => {
    const query = parseSearchParams(request.url, CursorPaginationRequestSchema);
    return listMessages(auth.userId, params.chatId, query);
  },
);

export const POST = withRoute<{ chatId: string }, unknown>(
  async ({ request, auth, params }) => {
    // Required, not optional with a server-generated fallback — an
    // idempotency guarantee a client can't opt into defeats the point.
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey) {
      throw new ValidationError("Idempotency-Key header is required");
    }
    const body = await parseJsonBody(request, SendMessageRequestSchema);
    return sendTurn(auth.userId, params.chatId, idempotencyKey, body);
  },
  { status: 202 },
);
