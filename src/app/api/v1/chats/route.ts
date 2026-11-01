import { withRoute, routeOptions, parseSearchParams, parseJsonBody } from "@/lib/route-handler";
import { ListChatsQuerySchema, CreateChatRequestSchema } from "@/contracts/chat";
import { listChats, createChat } from "@/services/chat";

export const OPTIONS = routeOptions;

export const GET = withRoute(async ({ request, auth }) => {
  const query = parseSearchParams(request.url, ListChatsQuerySchema);
  return listChats(auth.userId, query);
});

export const POST = withRoute(
  async ({ request, auth }) => {
    const body = await parseJsonBody(request, CreateChatRequestSchema);
    return createChat(auth.userId, body);
  },
  { status: 201 },
);
