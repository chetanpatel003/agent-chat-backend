import { withRoute, routeOptions, parseJsonBody } from "@/lib/route-handler";
import { UpdateChatRequestSchema } from "@/contracts/chat";
import { getChat, updateChat, deleteChat } from "@/services/chat";

export const OPTIONS = routeOptions;

export const GET = withRoute<{ chatId: string }, unknown>(
  async ({ auth, params }) => getChat(auth.userId, params.chatId),
);

export const PATCH = withRoute<{ chatId: string }, unknown>(
  async ({ request, auth, params }) => {
    const body = await parseJsonBody(request, UpdateChatRequestSchema);
    return updateChat(auth.userId, params.chatId, body);
  },
);

export const DELETE = withRoute<{ chatId: string }, unknown>(
  async ({ auth, params }) => deleteChat(auth.userId, params.chatId),
);
