import { authenticate } from "@/services/auth";
import { toErrorResponse } from "@/lib/errors";
import { withCors, handleOptions } from "@/lib/cors";
import {
  AuthenticatedUserResponseSchema,
  type AuthenticatedUserResponse,
} from "@/contracts/identity";

export async function OPTIONS(request: Request) {
  return handleOptions(request);
}

export async function GET(request: Request) {
  try {
    const { user } = await authenticate(request);

    const body: AuthenticatedUserResponse = AuthenticatedUserResponseSchema.parse({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      imageUrl: user.imageUrl,
      createdAt: user.createdAt.toISOString(),
    });

    return withCors(request, Response.json({ ok: true, data: body }));
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return withCors(request, Response.json(body, { status }));
  }
}
