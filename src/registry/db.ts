import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.js";

let _db: Database.Database | null = null;

export function db(): Database.Database {
  if (_db) return _db;
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const handle = new Database(config.dbPath);
  handle.pragma("journal_mode = WAL");
  handle.pragma("synchronous = NORMAL");
  handle.pragma("foreign_keys = ON");
  migrate(handle);
  _db = handle;
  return handle;
}

function migrate(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      ticket_key      TEXT PRIMARY KEY,
      issue_id        TEXT NOT NULL,
      session_id      TEXT,
      workspace_dir   TEXT,
      status          TEXT NOT NULL,
      summary         TEXT,
      pending_question TEXT,
      branch_name     TEXT,
      repo            TEXT,
      pr_urls         TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_key  TEXT,
      kind        TEXT NOT NULL,
      detail      TEXT,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_ticket ON events(ticket_key);
    CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);

    CREATE TABLE IF NOT EXISTS costs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_key   TEXT NOT NULL,
      session_id   TEXT,
      model        TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_creation_tokens INTEGER,
      cost_usd     REAL,
      created_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_costs_ticket ON costs(ticket_key);

    CREATE TABLE IF NOT EXISTS pending_queue (
      ticket_key  TEXT PRIMARY KEY,
      issue_id    TEXT NOT NULL,
      repo        TEXT,
      priority    INTEGER,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ipc_signals (
      ticket_key TEXT NOT NULL,
      kind       TEXT NOT NULL,
      payload    TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (ticket_key, kind)
    );

    CREATE TABLE IF NOT EXISTS merges (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_key    TEXT NOT NULL,
      pr_url        TEXT,
      merged_at     TEXT NOT NULL,
      files_changed INTEGER,
      lines_changed INTEGER,
      guards_passed TEXT
    );

    CREATE TABLE IF NOT EXISTS learnings_pending (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_key  TEXT NOT NULL,
      proposal    TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted | rejected
      created_at  TEXT NOT NULL
    );

    -- Tickets in staging_promote workflow currently in the
    -- "feature merged to dev → in rolling main PR" pipeline.
    -- stage: 'awaiting_check'    — feature merged, waiting for dev GHA
    --        'awaiting_redeploy' — GHA green, Coolify dev redeploy in flight
    CREATE TABLE IF NOT EXISTS dev_deploy_waits (
      ticket_key      TEXT PRIMARY KEY,
      issue_id        TEXT NOT NULL,
      repo            TEXT NOT NULL,
      feature_pr_url  TEXT NOT NULL,
      merge_sha       TEXT,
      check_name      TEXT NOT NULL,
      ticket_summary  TEXT,
      stage           TEXT NOT NULL DEFAULT 'awaiting_check',
      coolify_deployment_uuid TEXT,
      stage_entered_at TEXT,
      created_at      TEXT NOT NULL
    );

    -- One open dev->main PR per repo, accumulating ticket summaries in its body.
    -- Created when first ticket reaches "deployed to dev"; closed when human
    -- merges (or closes without merging).
    CREATE TABLE IF NOT EXISTS rolling_main_prs (
      repo         TEXT PRIMARY KEY,
      pr_number    INTEGER NOT NULL,
      pr_url       TEXT NOT NULL,
      ticket_keys  TEXT NOT NULL,  -- JSON array
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );

    -- Per-ticket content that backs the rolling PR body. Survives loss of the
    -- worker session and is the source of truth for re-rendering the PR body.
    -- Cleared per-repo when the rolling PR is merged or closed.
    CREATE TABLE IF NOT EXISTS rolling_pr_tickets (
      repo            TEXT NOT NULL,
      ticket_key      TEXT NOT NULL,
      ticket_summary  TEXT,
      feature_pr_url  TEXT NOT NULL,
      testing_steps   TEXT,   -- markdown block (bullets), nullable
      release_notes   TEXT,   -- markdown block (bullets), nullable
      added_at        TEXT NOT NULL,
      PRIMARY KEY (repo, ticket_key)
    );
    CREATE INDEX IF NOT EXISTS idx_rolling_pr_tickets_repo
      ON rolling_pr_tickets(repo, added_at);

    -- Post-merge promotion pipeline: rolling PR is MERGED, now wait for the
    -- main GHA check + trigger Coolify prod redeploy before closing tickets.
    -- stage: 'awaiting_main_check'  — main GHA running on merge SHA
    --        'awaiting_prod_redeploy' — Coolify prod redeploy in flight
    CREATE TABLE IF NOT EXISTS prod_promotions (
      repo         TEXT PRIMARY KEY,
      pr_url       TEXT NOT NULL,
      merge_sha    TEXT NOT NULL,
      ticket_keys  TEXT NOT NULL,  -- JSON array
      check_name   TEXT NOT NULL,
      stage        TEXT NOT NULL DEFAULT 'awaiting_main_check',
      coolify_deployment_uuid TEXT,
      stage_entered_at TEXT,
      created_at   TEXT NOT NULL
    );
  `);

  // Lightweight column adds for installs that pre-date the staging_promote
  // expansion (the CREATE TABLE IF NOT EXISTS above is a no-op then).
  addColumnIfMissing(d, "dev_deploy_waits", "stage", "TEXT NOT NULL DEFAULT 'awaiting_check'");
  addColumnIfMissing(d, "dev_deploy_waits", "coolify_deployment_uuid", "TEXT");
  addColumnIfMissing(d, "dev_deploy_waits", "stage_entered_at", "TEXT");
  addColumnIfMissing(d, "dev_deploy_waits", "testing_steps", "TEXT");
  addColumnIfMissing(d, "dev_deploy_waits", "release_notes", "TEXT");
}

function addColumnIfMissing(
  d: Database.Database,
  table: string,
  column: string,
  decl: string,
): void {
  const cols = d
    .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
    .all();
  if (cols.some((c) => c.name === column)) return;
  d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

export function logEvent(ticketKey: string | null, kind: string, detail?: unknown): void {
  db()
    .prepare(
      "INSERT INTO events (ticket_key, kind, detail, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(ticketKey, kind, detail == null ? null : JSON.stringify(detail), new Date().toISOString());
}
