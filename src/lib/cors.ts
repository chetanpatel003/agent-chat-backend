// Frontend and backend are separate origins (two repos, two deployments),
// so every route needs these headers or the browser blocks the response
// before the app ever sees it. One shared helper so it's consistent across
// routes instead of repeated (and potentially forgotten) per handler.

function allowedOrigin(request: Request): string | null {
  const origin = request.headers.get("origin");
  const configured = process.env.FRONTEND_ORIGIN;
  if (!origin || !configured) return null;
  return origin === configured ? origin : null;
}

export function corsHeaders(request: Request): HeadersInit {
  const origin = allowedOrigin(request);
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    Vary: "Origin",
  };
}

export function withCors(request: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(request))) {
    headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, headers });
}

export function handleOptions(request: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}
