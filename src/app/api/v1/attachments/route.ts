import { withRoute, routeOptions, parseJsonBody } from "@/lib/route-handler";
import { CreateAttachmentRequestSchema } from "@/contracts/attachment";
import { createAttachment } from "@/services/attachment";

export const OPTIONS = routeOptions;

export const POST = withRoute<Record<string, never>, unknown>(
  async ({ request, auth }) => createAttachment(auth.userId, await parseJsonBody(request, CreateAttachmentRequestSchema)),
  { status: 201 },
);
