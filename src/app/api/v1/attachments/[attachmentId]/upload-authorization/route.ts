import { withRoute, routeOptions } from "@/lib/route-handler";
import { authorizeUpload } from "@/services/attachment";

export const OPTIONS = routeOptions;

export const POST = withRoute<{ attachmentId: string }, unknown>(async ({ auth, params }) =>
  authorizeUpload(auth.userId, params.attachmentId),
);
