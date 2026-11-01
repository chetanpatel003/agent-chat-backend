import { withRoute, routeOptions } from "@/lib/route-handler";
import { getActiveRun } from "@/services/agent-run";

export const OPTIONS = routeOptions;

export const GET = withRoute<{ chatId: string }, unknown>(async ({ auth, params }) =>
  getActiveRun(auth.userId, params.chatId),
);
