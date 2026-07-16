# Donkai

> **Donk**ey work + **AI**. Pick up Linear tickets, hand them to Claude Code, get PRs back.

TypeScript orchestrator that polls Linear for tickets in a configured workflow state, spawns isolated [Claude Code](https://docs.claude.com/en/docs/claude-code) workers per ticket, and manages the full lifecycle — including suspend/resume when human input is needed, concurrency modes (parallel / sequential / sequential per repo), and optional auto-merge with safety guards.

Built on the official [`@linear/sdk`](https://www.npmjs.com/package/@linear/sdk) and [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) (no CLI subprocess — runs in-process).

## How it works

```
┌─────────┐  poll 60s    ┌──────────────┐  spawn   ┌─────────────┐
│ Linear  │◄────────────►│ Orchestrator │─────────►│ CC Worker 1 │──► PR
│  API    │              │  (Node/TS)   │─────────►│ CC Worker 2 │──► PR
└─────────┘              └──────────────┘          └─────────────┘
                              │                          │
                       SQLite (sessions,           BLOCKED? ──► Dashboard / Linear comment
                       events, costs, queue)
                              │
                       ┌──────────────┐
                       │  Dashboard   │  localhost:8346
                       │  (Hono+HTMX) │◄── approve / takeover / release
                       └──────────────┘
```

1. The orchestrator polls Linear every 60 s for issues assigned to you in the configured **Ready for Claude** state.
2. Each ticket is enqueued and scheduled according to `CONCURRENCY_MODE` (parallel / sequential / sequential_per_repo).
3. When scheduled, a worker workspace is created, `worker-CLAUDE.md` is copied in as `CLAUDE.md`, and a Claude Code session is started via the Agent SDK.
4. The worker reads the ticket, clones repos, does the work, pushes a feature branch, and opens a PR.
5. If the worker gets blocked it outputs `BLOCKED: <reason>`. The orchestrator routes to the **dashboard** (Tier 1 — quick clarifications) or **Linear** (Tier 2 — human action required) and suspends the session.
6. On `DONE:` the orchestrator either transitions to **Review** (default) or evaluates the auto-merge guards and squash-merges the PR, depending on `AUTONOMY_LEVEL`.

## Prerequisites

- Node 20+ and pnpm
- [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) installed and authenticated (the Agent SDK delegates to it, so your subscription auth is reused)
- Linear API key ([create one](https://linear.app/settings/account/security)) — needs `read`, `write`, and `comment` scopes
- One Linear team per `LINEAR_TEAM_KEYS`, with the workflow states named in `.env`

## Setup

```bash
git clone <this-repo>
cd donkai
pnpm install
cp .env.example .env
# edit .env: at minimum LINEAR_API_KEY and LINEAR_TEAM_KEYS
cp worker-CLAUDE.md.example worker-CLAUDE.md
# edit worker-CLAUDE.md to describe your stack
```

## Running

```bash
pnpm start          # orchestrator + dashboard together
pnpm dev            # same, auto-reload on source change
pnpm orchestrator   # orchestrator only
pnpm dashboard      # dashboard only
```

Dashboard: http://localhost:8346 (PWA) · http://localhost:8346/classic (HTMX fallback)

## HTTP surface

One Hono server on `DASHBOARD_PORT` serves everything:

| Path | What | Auth |
|---|---|---|
| `/` | Mobile PWA (installable, web push) | token entered in-app (Bearer to API) |
| `/api/v1/*` | JSON control API | `Authorization: Bearer $DONKAI_AUTH_TOKEN` |
| `/mcp` | MCP server (streamable HTTP) | Bearer token |
| `/mcp/<MCP_PATH_SECRET>` | Same, for claude.ai custom connectors (no header support there — the URL is the credential) | secret path |
| `/webhooks/linear` | Linear webhook doorbell (cuts pickup latency to ~2 s) | HMAC via `LINEAR_WEBHOOK_SECRET` |
| `/classic/*` | Original HTMX dashboard | basic auth via `DASHBOARD_TOKEN` |
| `/healthz` | Liveness + orchestrator heartbeat (stale tick ⇒ 503) | none |

## Phone access

**PWA:** open the deployed URL on your phone → Add to Home Screen → paste `DONKAI_AUTH_TOKEN` once. Enable push in Settings (needs `VAPID_*` keys, `npx web-push generate-vapid-keys`). You get pushes when a worker blocks, finishes, merges, or errors; pause/resume, reorder the queue, answer blocked workers, and edit pickup rules from the couch or the pub.

**claude.ai (MCP):** set `MCP_PATH_SECRET`, then claude.ai → Settings → Connectors → Add custom connector → `https://<domain>/mcp/<secret>`. Works in the Claude iOS/Android app: "what's donkai doing?", "move ENG-42 to the front", "pause processing", "answer the blocked worker: use approach B". 11 tools: status, list_queue, reorder_queue, pause, resume, ticket, answer_blocked, retry, costs, set_pickup_rules, deploy.

## Deploying on Coolify

Dockerfile included (node:20 + git + gh + Claude Code CLI preinstalled).

1. Coolify → new app → this repo → build pack **Dockerfile**, port **8346**.
2. Persistent volume mounted at **/data** (SQLite + workspaces + repo mirrors live there).
3. Env vars: everything from `.env`, plus `DONKAI_AUTH_TOKEN`, `GH_TOKEN` (fine-grained PAT, contents+PR on target repos), and `ANTHROPIC_API_KEY` **or** `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token` on a trusted machine). Put `worker-CLAUDE.md` on the volume and set `WORKER_CLAUDE_MD_PATH=/data/worker-CLAUDE.md`.
4. Domain + auto-HTTPS, healthcheck path `/healthz`.
5. Optional: Linear webhook → `https://<domain>/webhooks/linear` (Issues category) + `LINEAR_WEBHOOK_SECRET`.

> ⚠️ Trust model: workers execute repo code inside the same container as the orchestrator, with `GH_TOKEN`/`LINEAR_API_KEY` in env — same as running on your Mac, now on a server. Keep the target-repo set trusted.

## Token/latency diet (vs v1)

- **Harvest piggybacks** on the worker's DONE output (`HARVEST_MODE=piggyback`) — one full worker call per ticket eliminated.
- **Delta resumes**: only comments newer than the last run are re-sent (the session already holds the thread).
- **Per-ticket MCP selection**: workers load only `MCP_ALWAYS_SERVERS` + servers the ticket mentions (Sentry attachment ⇒ sentry server), not every server's tool schemas every turn.
- **Repo mirror cache** (`GIT_REMOTE_BASE`): tickets pre-clone from a local bare mirror; workers skip the network clone and the tokens narrating it.
- **Compressed worker context**: point `WORKER_CLAUDE_MD_COMPRESSED_PATH` at a caveman-compressed copy of `worker-CLAUDE.md`.

## Linear workflow setup

Create these workflow states on each team in `LINEAR_TEAM_KEYS`. Names must match `.env` exactly (case-insensitive on lookup, but Linear shows what you set).

| State | Type | Purpose |
|---|---|---|
| Ready for Claude | unstarted | Worker picks up |
| In Progress | started | Worker active |
| Waiting for human | started | Tier-2 block — needs human action |
| Review | started | PR open, CI green — human reviews |
| Done | completed | Approved & closed |

Transitions (Donkai handles all of these automatically):

```
Backlog → Ready for Claude → In Progress → Review → Done
                                  ↕
                          Waiting for human
```

A human only needs to:
- Move **Waiting for human → Ready for Claude** (after action + comment with result)
- Move **Review → Done** (after approving the PR)

## Concurrency modes

Set with `CONCURRENCY_MODE`:

| Mode | Behaviour |
|---|---|
| `parallel` | Up to `MAX_CONCURRENT_WORKERS` workers run simultaneously. CTC default. |
| `sequential` | One worker at a time globally; everything else queues. Drop 10 tickets in, walk away. |
| `sequential_per_repo` | Parallel across repos, serial within a repo. Best of both. Repo inferred via `REPO_INFERENCE` (`label_prefix` / `project` / `first_line`). |

## Autonomy levels

Set with `AUTONOMY_LEVEL`:

| Level | Behaviour |
|---|---|
| `review_only` | Worker opens PR, waits for green, transitions to Review. Human merges. (Default.) |
| `auto_merge_on_green` | Worker opens PR. After CI green + **all guards pass**, orchestrator squash-merges and closes ticket. |
| `full_yolo` | Same as auto_merge_on_green, plus the worker may retry failed CI up to `AUTO_MERGE_CI_RETRIES` times before blocking. |

### Auto-merge guards (all must pass)

| Guard | Knob |
|---|---|
| Repo on allowlist | `AUTO_MERGE_REPOS_ALLOWLIST` (empty = nothing eligible) |
| Required ticket label | `AUTO_MERGE_REQUIRE_LABEL` (e.g. `claude-auto`) |
| Max files changed | `AUTO_MERGE_MAX_FILES_CHANGED` |
| Max lines changed | `AUTO_MERGE_MAX_LINES_CHANGED` |
| No diff in blocked paths | `AUTO_MERGE_BLOCK_PATHS` (globs, e.g. `infra/**,terraform/**`) |
| No blocked keywords in output | `AUTO_MERGE_BLOCK_KEYWORDS` (e.g. `migration,schema,drop`) |

Auto-merged PRs are labelled `merged-by-claude` and recorded in the **Merges** tab of the dashboard with which guards passed.

**Kill switch:** flip `AUTONOMY_LEVEL=review_only` — every future ticket falls back to human-merge instantly. No state to unwind.

## Dashboard

| Tab | What it shows |
|---|---|
| Workers | Active sessions, status, pending Tier-1 questions, takeover/release controls |
| Queue | Pending tickets in scheduling order |
| Merges | Audit log of auto-merges (PR, diffstat, guards passed) |
| Learnings | Proposed `worker-CLAUDE.md` additions from the harvest step (accept / reject) |
| Costs | Per-day and per-ticket USD spend from Agent SDK usage |
| Events | Raw event log |

Optional basic-auth: set `DASHBOARD_TOKEN`. Username is hardcoded to `donkai`, password = token.

## Communication protocol

Workers output:

- `DONE: <summary>` — work complete; orchestrator transitions or merges based on autonomy
- `BLOCKED: <reason>` — needs human input

Tier-1 vs Tier-2 routing is decided by keyword match on `<reason>`. Configure via `TIER2_KEYWORDS`. Tier-1 → dashboard. Tier-2 → Linear comment + state change.

## Multi-person teams

Each person runs their own orchestrator on their own machine. The Linear query filters by `assignee = me`, so workers never collide.

## SQLite registry

Everything persists in `DONKAI_DB_PATH` (default `~/donkai-workers/donkai.sqlite`). Tables:

- `sessions` — worker state per ticket (replaces the JSON `.session_registry`)
- `events` — event log (orchestrator + handler events)
- `costs` — per-call token and USD cost from Agent SDK
- `pending_queue` — scheduled work waiting on concurrency budget
- `ipc_signals` — takeover / release / response from dashboard (replaces the four CTC JSON IPC files)
- `merges` — auto-merge audit log with guard pass/fail detail
- `learnings_pending` — proposed `worker-CLAUDE.md` additions awaiting human review

Worker statuses: `queued`, `pending`, `running`, `suspended_local`, `suspended_linear`, `awaiting_review`, `detached`, `merged`, `done`, `error`.

## Differences from CTC

| | CTC | Donkai |
|---|---|---|
| Language | Python | TypeScript |
| Ticket source | Jira REST + ADF | Linear GraphQL (markdown native) |
| Claude execution | `claude` CLI subprocess + stream-json parsing | Claude Agent SDK in-process |
| Persistence | 5 JSON files | SQLite (WAL) |
| Concurrency | unlimited parallel | parallel / sequential / sequential_per_repo |
| Autonomy | review_only (implicit) | review_only / auto_merge_on_green / full_yolo with guards |
| Cost tracking | none | per-call USD + tokens from SDK |
| Learning harvest | auto-commits worker-CLAUDE.md | proposes for human review |

## Licence

MIT
