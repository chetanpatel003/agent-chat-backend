import { withRoute, routeOptions } from "@/lib/route-handler";
import { listRunWaitpoints } from "@/services/waitpoint";

export const OPTIONS = routeOptions;

/** The run's waitpoints (oldest first) — how a reloaded client restores an open approval. */
export const GET = withRoute<{ chatId: string; runId: string }, unknown>(async ({ auth, params }) =>
  listRunWaitpoints(auth.userId, params.chatId, params.runId),
);
