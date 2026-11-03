import { withRoute, routeOptions } from "@/lib/route-handler";
import { getRun } from "@/services/agent-run";

export const OPTIONS = routeOptions;

/** Status of one run (any state, including terminal) — for polling long-running work. */
export const GET = withRoute<{ chatId: string; runId: string }, unknown>(async ({ auth, params }) =>
  getRun(auth.userId, params.chatId, params.runId),
);
