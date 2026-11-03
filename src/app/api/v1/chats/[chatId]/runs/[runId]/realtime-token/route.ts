import { withRoute, routeOptions } from "@/lib/route-handler";
import { getRealtimeToken } from "@/services/agent-run";

export const OPTIONS = routeOptions;

export const GET = withRoute<{ chatId: string; runId: string }, unknown>(async ({ auth, params }) =>
  getRealtimeToken(auth.userId, params.chatId, params.runId),
);
