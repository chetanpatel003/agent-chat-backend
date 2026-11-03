# Demo Deployment Runbook — Vercel + Trigger.dev

Purpose: a stable public URL for the assessment demo. Vercel's **Production** target is used only
because it gives a fixed URL; this is not a commercial launch. Free plans only (Vercel Hobby,
Trigger.dev Free, Neon Free, Clerk Development instance, Transloadit Community, Backblaze B2 free
tier, OpenRouter Free). Nothing here has been executed yet.

## 0. Before you start (owner-only steps)
1. `vercel login` — the stored CLI token on the dev machine is invalid.
2. Trigger.dev: the CLI is already logged in (project `proj_aoouuhfqtyyfqphyvnxz`). For option B you
   need the **Production** secret key (`tr_prod_…`) from the Trigger.dev dashboard.
3. Clerk dashboard access, to allow the frontend's demo origin.

## 1. Readiness checks (no side effects)
```sh
cd agent-chat-backend
pnpm prisma migrate status            # expect: "Database schema is up to date!"
pnpm vitest run --exclude src/services/send-turn.test.ts
pnpm tsc --noEmit && pnpm lint && pnpm build
cd ../agent-chat-frontend && pnpm vitest run && pnpm tsc --noEmit && pnpm lint && pnpm build
```
The demo uses the **existing Neon database** (all migrations through
`20261103220000_webhook_endpoint` applied; every migration is additive). Re-running
`pnpm prisma migrate deploy` is a no-op. Never run `migrate reset` or `migrate dev` against it.

## 2. Vercel — two projects, deployed from local source (no Git push)
`vercel deploy` uploads the working directory; no GitHub connection or push is needed.

### Backend (`agent-chat-backend`)
```sh
cd agent-chat-backend
vercel link                       # create the project "agent-chat-backend" (framework: Next.js)
vercel env add <NAME> production  # once per name below; paste values from .env — never commit them
vercel deploy --prod              # prints the backend URL, e.g. https://agent-chat-backend-xxxx.vercel.app
```
| Name | Notes |
|---|---|
| `DATABASE_URL` | Neon **pooled** URL |
| `DIRECT_DATABASE_URL` | Neon direct URL (migrations only; harmless at runtime) |
| `DATABASE_POOL_MAX` | optional; leave unset (10) on Vercel |
| `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` | the Clerk **Development** instance keys |
| `TRIGGER_SECRET_KEY`, `TRIGGER_PROJECT_REF` | dev key (option A) or prod key (option B) — see §3 |
| `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | model must be `openrouter/free`; anything else is refused |
| `MAGICA_API_KEY`, `MAGICA_BASE_URL` | |
| `TRANSLOADIT_KEY`, `TRANSLOADIT_SECRET` | Community plan |
| `B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET_NAME`, `B2_ENDPOINT`, `B2_REGION` | private bucket |
| `FRONTEND_ORIGIN` | the frontend URL, exact origin, no trailing slash (set after §2 frontend; redeploy) |

`FRONTEND_ORIGIN` drives both CORS (`src/lib/cors.ts`) and Clerk `authorizedParties`
(`src/services/auth.ts`): requests from any other origin are rejected.

### Frontend (`agent-chat-frontend`)
```sh
cd agent-chat-frontend
vercel link                       # project "agent-chat-frontend"
vercel env add NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY production
vercel env add CLERK_SECRET_KEY production
vercel env add NEXT_PUBLIC_API_URL production    # the backend URL from above
vercel deploy --prod
```
`NEXT_PUBLIC_API_URL` is baked in at build time — redeploy the frontend if it changes. Then set the
backend's `FRONTEND_ORIGIN` to the frontend URL and run `vercel deploy --prod` for the backend again.

### Clerk
A Development instance works on `*.vercel.app` (it shows Clerk's development banner); a Production
instance needs a domain you own, so it is not used for the demo. Add the frontend URL to the
instance's allowed origins / redirect URLs in the Clerk dashboard.

## 3. Trigger.dev — the worker (Vercel does not run it)
Agent turns, archival, settlement, webhook delivery and the three recovery sweeps run as Trigger.dev
tasks. Choose one:

| | A. Dev environment + local worker | B. Trigger.dev Cloud deployment |
|---|---|---|
| How | Backend uses the **dev** `TRIGGER_SECRET_KEY`; keep `pnpm trigger:dev` running on the laptop for the whole demo | `npx trigger.dev deploy`; backend uses the **prod** key |
| Availability | Only while the laptop and process run | Continuous |
| Setup | None beyond what works today | Set task env vars in the dashboard (Production): `DATABASE_URL`, `DATABASE_POOL_MAX` (optional), `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `MAGICA_API_KEY`, `MAGICA_BASE_URL`, `B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET_NAME`, `B2_ENDPOINT`, `B2_REGION` |
| Cost | Free | Free plan; the sweeps run every 5–10 min and use a little of the free compute |
| Risk | Laptop sleep/restart kills in-flight runs (waiting approvals are lost; the stale-run sweep and resolve-time checks recover them) | Env vars must be complete before deploy, or the sweeps fail repeatedly |

**Recommendation: B** for a link reviewers can use any time; **A** is acceptable for a supervised
live demo. Option B expects 7 tasks after deploy: `run-agent-turn`, `archive-generated-assets`,
`settle-tool-credits`, `deliver-webhook`, and the schedules `recover-billable-invocations` (*/10),
`recover-waitpoints` (*/5), `recover-stale-runs` (*/5).

Running A and B against the same database at once is safe (every sweep is guarded) but wasteful —
stop the local worker after switching to B.

## 4. Other services (already configured; nothing to change)
- **Neon**: one database; pooled URL at runtime, direct URL for migrations.
- **Transloadit Community**: signed Assembly parameters are created by the backend; the secret never
  reaches the browser. 5 GB/month, 0.5 GB per file.
- **Backblaze B2**: private bucket; files are served only as 1-hour signed URLs.
- **OpenRouter Free**: `openrouter/free`; non-`:free` routed models are refused before any text is
  shown. No paid fallback exists.
- **Magica**: real calls cost credits; Merge Videos is admitted only for uploaded videos with a measured duration, 5 minutes combined at most (decision 0018).

## 5. Smoke tests after deploy (no model or Magica calls)
```sh
B=https://<backend>.vercel.app; F=https://<frontend>.vercel.app
curl -s $B/api/health                                                        # {"ok":true}
curl -s -o /dev/null -w "%{http_code}\n" $B/api/v1/chats                     # 401
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer x" $B/api/v1/me   # 401
curl -s -o /dev/null -D - -X OPTIONS -H "Origin: $F" $B/api/v1/chats | grep -i access-control-allow-origin   # = $F
curl -s -o /dev/null -D - -X OPTIONS -H "Origin: https://evil.example" $B/api/v1/chats | grep -ci access-control-allow-origin   # 0
```
Browser (signed in at `$F`): create a chat, pin/unpin it, search, open the media picker, open an
existing chat with generated images. Trigger.dev dashboard: the 7 tasks are listed (B) and the
sweeps' recent runs succeed. Sending a message starts a real OpenRouter Free request — do it only
when that is intended.

## 6. Rollback
Vercel: `vercel rollback` or promote the previous deployment. Trigger.dev: redeploy the previous
version from the dashboard. The database needs no rollback (additive migrations only).
