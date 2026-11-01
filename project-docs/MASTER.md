# MASTER — permanent requirements and constraints

Full source of truth: assessment doc (pasted in conversation, not yet saved as a file — see open flag in PROJECT_STATE.md) + `/CLAUDE.md` (playbook, present in repo root, not committed).

## Evaluation weights (prioritization function)
1. Architecture & scalability — 25%
2. Cloning fidelity (vs live Galaxy reference) — 20%
3. Reliability & error handling — 20%
4. Code quality — 15%
5. Feature completeness — 10%
6. Polish & UX — 10%

## Hard constraints
- Two separate GitHub repos (this is the backend). Never collapse to a monorepo without approval.
- PostgreSQL + Prisma only. No Mongo/Redis/second DB.
- OpenRouter `openrouter/free` only, no paid fallback. Standard free-tier limits — no extra trial quota (evaluator confirmed).
- Crop Image, GPT Image 2, Merge Videos must be real Magica calls — never stubbed.
- Transloadit Community plan only, never upgraded.
- Secrets never reach browser code, prompts, logs, commits, or persisted messages.
- Backend independently verifies Clerk tokens and enforces ownership — never trusts the frontend (evaluator-confirmed condition on the two-repo architecture).
- Zod at every trust boundary. One authoritative tool registry. Idempotent dispatch/tool-completion/approval/charge.
- Ask before: destructive DB/git ops, paid services, deploys, external publishing.

## Reference product
https://app.galaxy.ai/chat (serves the Magica-branded app; Galaxy credits = Magica API credit balance, same pool).

## 11 non-negotiable feature areas (assessment §"Non-Negotiable Features")
Project structure · Contract-driven FE+BE · Skills system · Agent chat workspace · Message & attachment system · Required tool surface (Magica x3) · Execution engine · Chat management · Realtime conversation · Credits system · Error handling & debuggability.
Bonus (day 3 only, after mandatory paths work): public REST API, Mintlify docs, outbound webhooks, optional MCP server.

## Repos
- Backend (this repo): https://github.com/chetanpatel003/agent-chat-backend (private)
- Frontend: https://github.com/chetanpatel003/agent-chat-frontend (private)
