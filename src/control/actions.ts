import { EventEmitter } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { db, logEvent } from "../registry/db.js";
import {
  getSession,
  listSessions,
  upsertSession,
  type WorkerState,
} from "../registry/sessions.js";
import { listQueue, queuePosition } from "../orchestrator/queue.js";
import { pushSignal } from "../ipc/signals.js";
import { isPaused, lastTickAt, setPaused } from "./settings.js";

// In-process doorbell. The orchestrator loop listens; API/MCP/webhook handlers
// ring it so a tick starts immediately instead of waiting out the poll
// interval. Out-of-process callers still land on the ipc_signals fallback.
const wakeBus = new EventEmitter();
wakeBus.setMaxListeners(50);

export function wakeOrchestrator(reason: string): void {
  wakeBus.emit("wake", reason);
}

export function onWake(listener: (reason: string) => void): () => void {
  wakeBus.on("wake", listener);
  return () => wakeBus.off("wake", listener);
}

export interface StatusSummary {
  paused: boolean;
  lastTickAt: string | null;
  activeWorkers: Array<{
    ticket_key: string;
    status: string;
    summary: string | null;
    repo: string | null;
    pending_question: string | null;
    pr_urls: string[];
    updated_at: string;
  }>;
  queueLength: number;
  costTodayUsd: number;
}

const ACTIVE_STATUSES = new Set([
  "running",
  "suspended_local",
  "suspended_linear",
  "awaiting_dev_deploy",
  "awaiting_dev_redeploy",
  "awaiting_review",
  "detached",
  "error",
]);

export function getStatus(): StatusSummary {
  const today = new Date().toISOString().slice(0, 10);
  const cost = db()
    .prepare<[string], { total: number | null }>(
      "SELECT SUM(COALESCE(cost_usd, 0)) AS total FROM costs WHERE created_at >= ?",
    )
    .get(today)!.total;
  return {
    paused: isPaused(),
    lastTickAt: lastTickAt(),
    activeWorkers: listSessions()
      .filter((s) => ACTIVE_STATUSES.has(s.status))
      .map((s) => ({
        ticket_key: s.ticket_key,
        status: s.status,
        summary: s.summary,
        repo: s.repo,
        pending_question: s.pending_question,
        pr_urls: s.pr_urls,
        updated_at: s.updated_at,
      })),
    queueLength: listQueue().length,
    costTodayUsd: cost ?? 0,
  };
}

export function pause(): void {
  setPaused(true);
  logEvent(null, "processing_paused");
}

export function resume(): void {
  setPaused(false);
  logEvent(null, "processing_resumed");
  wakeOrchestrator("resume");
}

// Full or partial reorder: named tickets get manual_order 0..n-1 (front of the
// queue in the given order); unnamed tickets keep NULL and sort after by the
// old priority/created_at rules.
export function reorderQueue(order: string[]): { applied: string[]; unknown: string[] } {
  const known = new Set(listQueue().map((r) => r.ticket_key));
  const applied: string[] = [];
  const unknown: string[] = [];
  const clear = db().prepare("UPDATE pending_queue SET manual_order = NULL");
  const set = db().prepare("UPDATE pending_queue SET manual_order = ? WHERE ticket_key = ?");
  db().transaction(() => {
    clear.run();
    order.forEach((key, i) => {
      if (known.has(key)) {
        set.run(i, key);
        applied.push(key);
      } else {
        unknown.push(key);
      }
    });
  })();
  logEvent(null, "queue_reordered", { order: applied });
  wakeOrchestrator("reorder");
  return { applied, unknown };
}

export function answerBlocked(ticketKey: string, answer: string): boolean {
  const state = getSession(ticketKey);
  if (!state || state.status !== "suspended_local") return false;
  pushSignal(ticketKey, "response", answer);
  wakeOrchestrator("answer");
  return true;
}

export function requestTakeover(ticketKey: string): void {
  pushSignal(ticketKey, "takeover");
  wakeOrchestrator("takeover");
}

export function requestRelease(ticketKey: string): void {
  pushSignal(ticketKey, "release");
  wakeOrchestrator("release");
}

// Re-enqueue an errored ticket so the loop picks it up as new work.
export function retryTicket(ticketKey: string): boolean {
  const state = getSession(ticketKey);
  if (!state || state.status !== "error") return false;
  db()
    .prepare(
      `INSERT INTO pending_queue (ticket_key, issue_id, repo, priority, created_at)
       VALUES (?, ?, ?, NULL, ?)
       ON CONFLICT(ticket_key) DO NOTHING`,
    )
    .run(ticketKey, state.issue_id, state.repo, new Date().toISOString());
  state.status = "queued";
  state.pending_question = null;
  upsertSession(state);
  logEvent(ticketKey, "ticket_retry");
  wakeOrchestrator("retry");
  return true;
}

export interface LogTail {
  lines: string[];
  offset: number;
}

// Tail of the worker JSONL log rendered to readable lines. `after` is a byte
// offset from a previous call for cheap incremental polling.
export function tailLog(ticketKey: string, opts: { tail?: number; after?: number } = {}): LogTail | null {
  const state = getSession(ticketKey);
  if (!state?.workspace_dir) return null;
  const logPath = join(state.workspace_dir, "cc.log");
  if (!existsSync(logPath)) return { lines: [], offset: 0 };
  const size = statSync(logPath).size;
  const raw = readFileSync(logPath, "utf-8");
  const from = opts.after != null ? Math.min(opts.after, raw.length) : 0;
  const slice = raw.slice(from);
  let lines = slice.split("\n").filter(Boolean).map(renderLogLine).filter(Boolean) as string[];
  if (opts.after == null && opts.tail) lines = lines.slice(-opts.tail);
  return { lines, offset: size };
}

function renderLogLine(line: string): string | null {
  if (!line.startsWith("{")) return line;
  try {
    const msg = JSON.parse(line) as {
      type?: string;
      subtype?: string;
      result?: string;
      message?: { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> };
    };
    if (msg.type === "system" && msg.subtype === "init") return "[session started]";
    if (msg.type === "result") return `[result] ${(msg.result ?? "").slice(0, 2000)}`;
    if (msg.type === "assistant" && msg.message?.content) {
      return msg.message.content
        .map((b) => {
          if (b.type === "text" && b.text) return b.text;
          if (b.type === "tool_use") return `→ ${b.name}(${JSON.stringify(b.input ?? {}).slice(0, 200)})`;
          return null;
        })
        .filter(Boolean)
        .join("\n") || null;
    }
    return null; // user/tool-result messages: noise for a phone screen
  } catch {
    return line;
  }
}

export function listQueueWithPositions(): Array<{
  position: number;
  ticket_key: string;
  repo: string | null;
  priority: number | null;
  manual_order: number | null;
  created_at: string;
}> {
  return listQueue().map((r, i) => ({
    position: i + 1,
    ticket_key: r.ticket_key,
    repo: r.repo,
    priority: r.priority,
    manual_order: (r as { manual_order?: number | null }).manual_order ?? null,
    created_at: r.created_at,
  }));
}

export type TicketDetail = WorkerState & { queuePosition: number | null };

export function getTicketDetail(ticketKey: string): TicketDetail | null {
  const s = getSession(ticketKey);
  if (!s) return null;
  return { ...s, queuePosition: queuePosition(ticketKey) };
}

export interface CostSummary {
  daily: Array<{ day: string; cost: number; tickets: number }>;
  perTicket: Array<{ ticket_key: string; total: number; calls: number }>;
}

export function getCosts(days = 30): CostSummary {
  const daily = db()
    .prepare<[number], { day: string; cost: number; tickets: number }>(
      `SELECT substr(created_at, 1, 10) AS day,
              SUM(COALESCE(cost_usd, 0)) AS cost,
              COUNT(DISTINCT ticket_key) AS tickets
         FROM costs GROUP BY day ORDER BY day DESC LIMIT ?`,
    )
    .all(days);
  const perTicket = db()
    .prepare<[], { ticket_key: string; total: number; calls: number }>(
      `SELECT ticket_key, SUM(COALESCE(cost_usd, 0)) AS total, COUNT(*) AS calls
         FROM costs GROUP BY ticket_key ORDER BY total DESC LIMIT 50`,
    )
    .all();
  return { daily, perTicket };
}
