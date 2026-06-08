import { config } from "../config.js";
import { db } from "../registry/db.js";
import {
  activeCount,
  blockingCount,
  blockingReposActive,
  blockingSessions,
  getSession,
} from "../registry/sessions.js";
import type { IssueSummary } from "../linear/queries.js";

interface QueueRow {
  ticket_key: string;
  issue_id: string;
  repo: string | null;
  priority: number | null;
  created_at: string;
}

export function inferRepo(issue: IssueSummary): string | null {
  switch (config.concurrency.repoInference) {
    case "label_prefix": {
      const lbl = issue.labels.find((l) => l.toLowerCase().startsWith("repo:"));
      return lbl ? lbl.slice("repo:".length).trim() : null;
    }
    case "project":
      return issue.project ?? null;
    case "first_line": {
      const line = issue.description
        .split("\n")
        .map((l) => l.trim())
        .find(Boolean);
      if (!line) return null;
      const m = line.match(/^Repo:\s*(\S+)/i);
      return m ? m[1] ?? null : null;
    }
  }
}

export function enqueue(issue: IssueSummary, repo: string | null): void {
  db()
    .prepare(
      `INSERT INTO pending_queue (ticket_key, issue_id, repo, priority, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(ticket_key) DO NOTHING`,
    )
    .run(
      issue.identifier,
      issue.id,
      repo,
      issue.priority,
      new Date().toISOString(),
    );
}

export function dequeue(ticketKey: string): void {
  db().prepare("DELETE FROM pending_queue WHERE ticket_key = ?").run(ticketKey);
}

export function listQueue(): QueueRow[] {
  return db()
    .prepare<[], QueueRow>(
      `SELECT * FROM pending_queue
        ORDER BY COALESCE(priority, 99) ASC, created_at ASC`,
    )
    .all();
}

export function pickNextRunnable(): QueueRow[] {
  const rows = listQueue();
  if (rows.length === 0) return [];
  const mode = config.concurrency.mode;
  const cap = config.concurrency.maxConcurrent;

  switch (mode) {
    case "parallel": {
      const free = Math.max(0, cap - activeCount());
      return rows.slice(0, free);
    }
    case "sequential": {
      if (blockingCount() > 0) {
        logBlockedQueue();
        return [];
      }
      return rows.slice(0, 1);
    }
    case "sequential_per_repo": {
      const busy = blockingReposActive();
      const picked: QueueRow[] = [];
      const claimed = new Set<string>();
      for (const r of rows) {
        if (picked.length >= cap) break;
        const repo = r.repo ?? "__none__";
        if (busy.has(repo) || claimed.has(repo)) continue;
        picked.push(r);
        claimed.add(repo);
      }
      if (picked.length === 0 && rows.length > 0) logBlockedQueue();
      return picked;
    }
  }
}

export function queuePosition(ticketKey: string): number | null {
  const all = listQueue();
  const idx = all.findIndex((r) => r.ticket_key === ticketKey);
  return idx < 0 ? null : idx + 1;
}

let lastBlockedLog = "";
function logBlockedQueue(): void {
  const blockers = blockingSessions().map(
    (s) => `${s.ticket_key}(${s.status})`,
  );
  const msg = blockers.join(", ");
  if (msg === lastBlockedLog) return;
  lastBlockedLog = msg;
  console.log(
    `  ⏸ queue waiting on prior work to finalize (merge/close): ${msg || "(none)"}`,
  );
}

export function alreadyQueuedOrRunning(ticketKey: string): boolean {
  const session = getSession(ticketKey);
  if (
    session &&
    ["running", "suspended_local", "suspended_linear", "awaiting_review", "detached", "queued"].includes(
      session.status,
    )
  ) {
    return true;
  }
  return !!db().prepare("SELECT 1 FROM pending_queue WHERE ticket_key = ?").get(ticketKey);
}
