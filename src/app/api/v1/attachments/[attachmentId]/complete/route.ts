import { withRoute, routeOptions, parseJsonBody } from "@/lib/route-handler";
import { CompleteAttachmentRequestSchema } from "@/contracts/attachment";
import { completeUpload } from "@/services/attachment";

export const OPTIONS = routeOptions;

export const POST = withRoute<{ attachmentId: string }, unknown>(async ({ request, auth, params }) => {
  const { assemblyId } = await parseJsonBody(request, CompleteAttachmentRequestSchema);
  return completeUpload(auth.userId, params.attachmentId, assemblyId);
});
