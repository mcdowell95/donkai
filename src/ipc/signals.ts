import { db } from "../registry/db.js";

export type SignalKind = "takeover" | "release" | "response";

interface SignalRow {
  ticket_key: string;
  kind: string;
  payload: string | null;
  created_at: string;
}

export function pushSignal(
  ticketKey: string,
  kind: SignalKind,
  payload?: string,
): void {
  db()
    .prepare(
      `INSERT INTO ipc_signals (ticket_key, kind, payload, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(ticket_key, kind) DO UPDATE SET
         payload = excluded.payload,
         created_at = excluded.created_at`,
    )
    .run(ticketKey, kind, payload ?? null, new Date().toISOString());
}

export function consumeSignal(
  ticketKey: string,
  kind: SignalKind,
): string | null {
  const row = db()
    .prepare<[string, string], SignalRow>(
      "SELECT * FROM ipc_signals WHERE ticket_key = ? AND kind = ?",
    )
    .get(ticketKey, kind);
  if (!row) return null;
  db()
    .prepare("DELETE FROM ipc_signals WHERE ticket_key = ? AND kind = ?")
    .run(ticketKey, kind);
  return row.payload ?? "";
}

export function peekSignal(ticketKey: string, kind: SignalKind): boolean {
  return !!db()
    .prepare("SELECT 1 FROM ipc_signals WHERE ticket_key = ? AND kind = ?")
    .get(ticketKey, kind);
}

export function listSignals(kind: SignalKind): { ticketKey: string; payload: string }[] {
  const rows = db()
    .prepare<[string], SignalRow>(
      "SELECT * FROM ipc_signals WHERE kind = ?",
    )
    .all(kind);
  return rows.map((r) => ({ ticketKey: r.ticket_key, payload: r.payload ?? "" }));
}

export function hasAnyPendingSignal(): boolean {
  return !!db().prepare("SELECT 1 FROM ipc_signals LIMIT 1").get();
}
