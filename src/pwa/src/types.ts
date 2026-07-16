export interface WorkerInfo {
  ticket_key: string;
  status: string;
  summary: string | null;
  repo: string | null;
  pending_question: string | null;
  pr_urls: string[] | string | null;
  updated_at: string;
}

export interface StatusResponse {
  paused: boolean;
  lastTickAt: string | null;
  activeWorkers: WorkerInfo[];
  queueLength: number;
  costTodayUsd: number;
}

export interface SessionRow {
  ticket_key: string;
  issue_id: string;
  session_id: string | null;
  workspace_dir: string | null;
  status: string;
  summary: string | null;
  pending_question: string | null;
  branch_name: string | null;
  repo: string | null;
  pr_urls: string[] | string | null;
  last_worker_finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionDetail extends SessionRow {
  queuePosition: number | null;
}

export interface LogChunk {
  lines: string[];
  offset: number;
}

export interface QueueItem {
  position: number;
  ticket_key: string;
  repo: string | null;
  priority: number | null;
  manual_order: number | null;
  created_at: string;
}

export interface Rule {
  id: number;
  enabled: number | boolean;
  team_key: string | null;
  label: string | null;
  max_priority_num: number | null;
  repo: string | null;
  note: string | null;
  created_at: string;
}

export interface Learning {
  id: number;
  ticket_key: string;
  proposal: string; // JSON string {proposal, section}
  created_at: string;
}

export interface CostsResponse {
  daily: { day: string; cost: number; tickets: number }[];
  perTicket: { ticket_key: string; total: number; calls: number }[];
}

/** pr_urls may arrive as a JSON string straight from sqlite — normalize. */
export function prUrls(value: string[] | string | null | undefined): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export const PRIORITY_LABELS: Record<number, string> = {
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

export function priorityLabel(p: number | null | undefined): string {
  if (p == null) return "—";
  return PRIORITY_LABELS[p] ?? `P${p}`;
}
