import { withRoute, routeOptions, parseSearchParams } from "@/lib/route-handler";
import { CursorPaginationRequestSchema } from "@/contracts/pagination";
import { listMessages } from "@/services/message";

export const OPTIONS = routeOptions;

export const GET = withRoute<{ chatId: string }, unknown>(
  async ({ request, auth, params }) => {
    const query = parseSearchParams(request.url, CursorPaginationRequestSchema);
    return listMessages(auth.userId, params.chatId, query);
  },
);
