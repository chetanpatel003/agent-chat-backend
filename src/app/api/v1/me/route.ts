import { withRoute, routeOptions } from "@/lib/route-handler";
import { AuthenticatedUserResponseSchema } from "@/contracts/identity";

export const OPTIONS = routeOptions;

export const GET = withRoute(async ({ auth }) =>
  AuthenticatedUserResponseSchema.parse({
    id: auth.user.id,
    email: auth.user.email,
    displayName: auth.user.displayName,
    imageUrl: auth.user.imageUrl,
    createdAt: auth.user.createdAt.toISOString(),
  }),
);
