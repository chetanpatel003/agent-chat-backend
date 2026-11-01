import { withRoute, routeOptions } from "@/lib/route-handler";
import { getBalance } from "@/services/credits";

export const OPTIONS = routeOptions;

export const GET = withRoute(async ({ auth }) => getBalance(auth.userId));
