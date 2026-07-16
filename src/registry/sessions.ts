import { db } from "./db.js";

export type WorkerStatus =
  | "queued"
  | "pending"
  | "running"
  | "suspended_local"
  | "suspended_linear"
  | "awaiting_dev_deploy"
  | "awaiting_dev_redeploy"
  | "awaiting_review"
  | "detached"
  | "merged"
  | "done"
  | "error";

export interface WorkerState {
  ticket_key: string;
  issue_id: string;
  session_id: string | null;
  workspace_dir: string | null;
  status: WorkerStatus;
  summary: string | null;
  pending_question: string | null;
  branch_name: string | null;
  repo: string | null;
  pr_urls: string[];
  last_worker_finished_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SessionRow {
  ticket_key: string;
  issue_id: string;
  session_id: string | null;
  workspace_dir: string | null;
  status: string;
  summary: string | null;
  pending_question: string | null;
  branch_name: string | null;
  repo: string | null;
  pr_urls: string | null;
  last_worker_finished_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToState(row: SessionRow): WorkerState {
  return {
    ticket_key: row.ticket_key,
    issue_id: row.issue_id,
    session_id: row.session_id,
    workspace_dir: row.workspace_dir,
    status: row.status as WorkerStatus,
    summary: row.summary,
    pending_question: row.pending_question,
    branch_name: row.branch_name,
    repo: row.repo,
    pr_urls: row.pr_urls ? (JSON.parse(row.pr_urls) as string[]) : [],
    last_worker_finished_at: row.last_worker_finished_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function getSession(ticketKey: string): WorkerState | null {
  const row = db()
    .prepare<[string], SessionRow>("SELECT * FROM sessions WHERE ticket_key = ?")
    .get(ticketKey);
  return row ? rowToState(row) : null;
}

export function listSessions(): WorkerState[] {
  const rows = db()
    .prepare<[], SessionRow>("SELECT * FROM sessions ORDER BY updated_at DESC")
    .all();
  return rows.map(rowToState);
}

export function upsertSession(state: WorkerState): void {
  const now = new Date().toISOString();
  state.updated_at = now;
  db()
    .prepare(
      `INSERT INTO sessions (
         ticket_key, issue_id, session_id, workspace_dir, status, summary,
         pending_question, branch_name, repo, pr_urls, last_worker_finished_at,
         created_at, updated_at
       ) VALUES (
         @ticket_key, @issue_id, @session_id, @workspace_dir, @status, @summary,
         @pending_question, @branch_name, @repo, @pr_urls, @last_worker_finished_at,
         @created_at, @updated_at
       )
       ON CONFLICT(ticket_key) DO UPDATE SET
         issue_id        = excluded.issue_id,
         session_id      = excluded.session_id,
         workspace_dir   = excluded.workspace_dir,
         status          = excluded.status,
         summary         = excluded.summary,
         pending_question= excluded.pending_question,
         branch_name     = excluded.branch_name,
         repo            = excluded.repo,
         pr_urls         = excluded.pr_urls,
         last_worker_finished_at = excluded.last_worker_finished_at,
         updated_at      = excluded.updated_at`,
    )
    .run({
      ...state,
      pr_urls: JSON.stringify(state.pr_urls),
    });
}

export function newState(opts: {
  ticket_key: string;
  issue_id: string;
  summary?: string | null;
  repo?: string | null;
  status?: WorkerStatus;
}): WorkerState {
  const now = new Date().toISOString();
  return {
    ticket_key: opts.ticket_key,
    issue_id: opts.issue_id,
    session_id: null,
    workspace_dir: null,
    status: opts.status ?? "pending",
    summary: opts.summary ?? null,
    pending_question: null,
    branch_name: null,
    repo: opts.repo ?? null,
    pr_urls: [],
    last_worker_finished_at: null,
    created_at: now,
    updated_at: now,
  };
}

export function activeCount(): number {
  return db()
    .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM sessions WHERE status = 'running'")
    .get()!.c;
}

export function activeReposRunning(): Set<string> {
  const rows = db()
    .prepare<[], { repo: string | null }>(
      "SELECT repo FROM sessions WHERE status = 'running'",
    )
    .all();
  return new Set(rows.map((r) => r.repo).filter((r): r is string => !!r));
}

// Statuses that hold up a sequential slot — prior work isn't finalized yet,
// so starting a new worker risks branching off a stale base and conflicting
// at merge time. `merged`, `done`, `error`, `queued` are never blocking.
//
// In `staging_promote` workflow, `awaiting_review` means "merged to dev,
// deployed to dev, waiting for human to merge dev->main" — that's the
// deliberate parking state and must NOT block the queue. Callers pass the
// set they want via `blockingStatuses`.
export const BASE_BLOCKING_STATUSES = [
  "pending",
  "running",
  "suspended_local",
  "suspended_linear",
  "awaiting_dev_deploy",
  "awaiting_dev_redeploy",
  "detached",
] as const;

function placeholders(arr: readonly string[]): string {
  return arr.map(() => "?").join(",");
}

export function blockingCount(statuses: readonly string[]): number {
  if (statuses.length === 0) return 0;
  return db()
    .prepare<string[], { c: number }>(
      `SELECT COUNT(*) AS c FROM sessions WHERE status IN (${placeholders(statuses)})`,
    )
    .get(...statuses)!.c;
}

export function blockingSessions(statuses: readonly string[]): WorkerState[] {
  if (statuses.length === 0) return [];
  const rows = db()
    .prepare<string[], SessionRow>(
      `SELECT * FROM sessions WHERE status IN (${placeholders(statuses)}) ORDER BY updated_at ASC`,
    )
    .all(...statuses);
  return rows.map(rowToState);
}

export function blockingReposActive(statuses: readonly string[]): Set<string> {
  if (statuses.length === 0) return new Set();
  const rows = db()
    .prepare<string[], { repo: string | null }>(
      `SELECT repo FROM sessions WHERE status IN (${placeholders(statuses)})`,
    )
    .all(...statuses);
  return new Set(rows.map((r) => r.repo).filter((r): r is string => !!r));
}

export function listSessionsByStatus(status: WorkerStatus): WorkerState[] {
  const rows = db()
    .prepare<[string], SessionRow>(
      "SELECT * FROM sessions WHERE status = ? ORDER BY updated_at ASC",
    )
    .all(status);
  return rows.map(rowToState);
}
