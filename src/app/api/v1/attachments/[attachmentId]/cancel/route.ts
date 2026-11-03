import { withRoute, routeOptions } from "@/lib/route-handler";
import { cancelUpload } from "@/services/attachment";

export const OPTIONS = routeOptions;

export const POST = withRoute<{ attachmentId: string }, unknown>(async ({ auth, params }) =>
  cancelUpload(auth.userId, params.attachmentId),
);
