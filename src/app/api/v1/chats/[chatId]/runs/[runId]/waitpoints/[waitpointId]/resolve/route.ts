import { withRoute, routeOptions, parseJsonBody } from "@/lib/route-handler";
import { ResolveWaitpointRequestSchema } from "@/contracts/waitpoint";
import { resolveWaitpoint } from "@/services/waitpoint";

export const OPTIONS = routeOptions;

/** Idempotent: the first decision wins; repeating the request re-ensures the run resumes. */
export const POST = withRoute<{ chatId: string; runId: string; waitpointId: string }, unknown>(
  async ({ request, auth, params }) => {
    const body = await parseJsonBody(request, ResolveWaitpointRequestSchema);
    return resolveWaitpoint(auth.userId, params.chatId, params.runId, params.waitpointId, body);
  },
);
