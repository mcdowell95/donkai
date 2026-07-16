import { config } from "../config.js";
import { db } from "../registry/db.js";
import {
  activeCount,
  BASE_BLOCKING_STATUSES,
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
  manual_order: number | null;
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
        ORDER BY COALESCE(manual_order, 1000000000) ASC,
                 COALESCE(priority, 99) ASC, created_at ASC`,
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
      const blockers = sequentialBlockingStatuses();
      if (blockingCount(blockers) > 0) {
        logBlockedQueue(blockers);
        return [];
      }
      return rows.slice(0, 1);
    }
    case "sequential_per_repo": {
      const blockers = sequentialBlockingStatuses();
      const busy = blockingReposActive(blockers);
      const picked: QueueRow[] = [];
      const claimed = new Set<string>();
      for (const r of rows) {
        if (picked.length >= cap) break;
        const repo = r.repo ?? "__none__";
        if (busy.has(repo) || claimed.has(repo)) continue;
        picked.push(r);
        claimed.add(repo);
      }
      if (picked.length === 0 && rows.length > 0) logBlockedQueue(blockers);
      return picked;
    }
  }
}

export function queuePosition(ticketKey: string): number | null {
  const all = listQueue();
  const idx = all.findIndex((r) => r.ticket_key === ticketKey);
  return idx < 0 ? null : idx + 1;
}

// In direct_main, `awaiting_review` means PR open against main and unmerged —
// must block to avoid the second worker branching off a stale main. In
// staging_promote, `awaiting_review` means "deployed to dev, parked on the
// rolling main PR for human" — that's intentional and must NOT block.
function sequentialBlockingStatuses(): readonly string[] {
  if (config.workflow.mode === "staging_promote") {
    return BASE_BLOCKING_STATUSES;
  }
  return [...BASE_BLOCKING_STATUSES, "awaiting_review"];
}

let lastBlockedLog = "";
function logBlockedQueue(statuses: readonly string[]): void {
  const blockers = blockingSessions(statuses).map(
    (s) => `${s.ticket_key}(${s.status})`,
  );
  const msg = blockers.join(", ");
  if (msg === lastBlockedLog) return;
  lastBlockedLog = msg;
  console.log(
    `  ⏸ queue waiting on prior work to finalize: ${msg || "(none)"}`,
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
