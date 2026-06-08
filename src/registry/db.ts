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
  `);
}

export function logEvent(ticketKey: string | null, kind: string, detail?: unknown): void {
  db()
    .prepare(
      "INSERT INTO events (ticket_key, kind, detail, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(ticketKey, kind, detail == null ? null : JSON.stringify(detail), new Date().toISOString());
}
