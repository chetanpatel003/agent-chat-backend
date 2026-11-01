import type { z } from "zod";
import { authenticate, type AuthContext } from "@/services/auth";
import { toErrorResponse, ValidationError } from "@/lib/errors";
import { withCors, handleOptions } from "@/lib/cors";

type RouteHandlerArgs<P> = {
  request: Request;
  auth: AuthContext;
  params: P;
};

/**
 * Every authenticated route is: authenticate -> validate -> call a
 * service -> map the result to the standard envelope. This wrapper is
 * that shape, written once, so each route file only contains what's
 * actually specific to it — see backend rules: "Route handlers stay
 * thin; delegate to application services."
 */
export function withRoute<P, T>(
  handler: (args: RouteHandlerArgs<P>) => Promise<T>,
  options: { status?: number } = {},
) {
  return async (
    request: Request,
    routeCtx?: { params: Promise<P> },
  ): Promise<Response> => {
    try {
      const auth = await authenticate(request);
      const params = routeCtx ? await routeCtx.params : ({} as P);
      const data = await handler({ request, auth, params });
      return withCors(
        request,
        Response.json({ ok: true, data }, { status: options.status ?? 200 }),
      );
    } catch (error) {
      const { status, body } = toErrorResponse(error);
      return withCors(request, Response.json(body, { status }));
    }
  };
}

/** Shared OPTIONS handler every route under /api/v1 exports the same way. */
export function routeOptions(request: Request): Response {
  return handleOptions(request);
}

/** Validates URL search params against a Zod schema. Tolerates an absent
 * param (undefined, not the string "undefined") so optional fields with
 * defaults behave the same whether the query string omits them or the
 * caller never sends that param at all. */
export function parseSearchParams<T extends z.ZodTypeAny>(
  url: string,
  schema: T,
): z.infer<T> {
  const params = new URL(url).searchParams;
  const raw = Object.fromEntries(params.entries());
  return schema.parse(raw);
}

/** Validates a JSON request body. An empty body is treated as `{}` rather
 * than a parse error, so a POST with no body validates against schemas
 * whose fields are all optional (e.g. create-chat with no title). */
export async function parseJsonBody<T extends z.ZodTypeAny>(
  request: Request,
  schema: T,
): Promise<z.infer<T>> {
  const text = await request.text();
  if (!text.trim()) return schema.parse({});
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ValidationError("Request body is not valid JSON");
  }
  return schema.parse(json);
}
