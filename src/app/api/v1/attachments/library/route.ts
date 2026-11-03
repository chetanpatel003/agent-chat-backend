import { withRoute, routeOptions, parseSearchParams } from "@/lib/route-handler";
import { CursorPaginationRequestSchema } from "@/contracts/pagination";
import { listMediaLibrary } from "@/services/attachment";

export const OPTIONS = routeOptions;

/** The caller's media library (their own media only), newest first. */
export const GET = withRoute<Record<string, never>, unknown>(async ({ request, auth }) =>
  listMediaLibrary(auth.userId, parseSearchParams(request.url, CursorPaginationRequestSchema)),
);
