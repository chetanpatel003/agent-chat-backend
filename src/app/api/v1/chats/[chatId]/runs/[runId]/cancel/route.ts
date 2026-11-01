import { withRoute, routeOptions } from "@/lib/route-handler";
import { cancelRun } from "@/services/agent-run";

export const OPTIONS = routeOptions;

export const POST = withRoute<{ chatId: string; runId: string }, unknown>(async ({ auth, params }) =>
  cancelRun(auth.userId, params.chatId, params.runId),
);
