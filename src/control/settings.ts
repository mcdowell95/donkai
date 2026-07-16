import { db } from "../registry/db.js";

export function getSetting(key: string): string | null {
  const row = db()
    .prepare<[string], { value: string }>("SELECT value FROM settings WHERE key = ?")
    .get(key);
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, new Date().toISOString());
}

export function isPaused(): boolean {
  return getSetting("paused") === "1";
}

export function setPaused(paused: boolean): void {
  setSetting("paused", paused ? "1" : "0");
}

export function recordTick(): void {
  setSetting("last_tick_at", new Date().toISOString());
}

export function lastTickAt(): string | null {
  return getSetting("last_tick_at");
}
