import { withRoute, routeOptions, parseSearchParams } from "@/lib/route-handler";
import { CursorPaginationRequestSchema } from "@/contracts/pagination";
import { listLedger } from "@/services/credits";

export const OPTIONS = routeOptions;

export const GET = withRoute(async ({ request, auth }) => {
  const query = parseSearchParams(request.url, CursorPaginationRequestSchema);
  return listLedger(auth.userId, query);
});
