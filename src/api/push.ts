import webpush from "web-push";
import { config } from "../config.js";
import { db, logEvent } from "../registry/db.js";

let configured = false;

function ensureConfigured(): boolean {
  if (configured) return true;
  if (!config.push.vapidPublicKey || !config.push.vapidPrivateKey) return false;
  webpush.setVapidDetails(
    config.push.vapidSubject,
    config.push.vapidPublicKey,
    config.push.vapidPrivateKey,
  );
  configured = true;
  return true;
}

export interface PushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export function saveSubscription(sub: PushSubscriptionJson): void {
  db()
    .prepare(
      `INSERT INTO push_subscriptions (endpoint, keys_json, created_at) VALUES (?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET keys_json = excluded.keys_json`,
    )
    .run(sub.endpoint, JSON.stringify(sub.keys), new Date().toISOString());
}

export function removeSubscription(endpoint: string): void {
  db().prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
}

export type NotifyKind = "blocked" | "done" | "merged" | "error" | "deploy";

// Fire-and-forget: never let a push failure disturb the orchestrator path.
export function notify(kind: NotifyKind, ticketKey: string | null, body: string): void {
  if (!ensureConfigured()) return;
  const rows = db()
    .prepare<[], { endpoint: string; keys_json: string }>(
      "SELECT endpoint, keys_json FROM push_subscriptions",
    )
    .all();
  if (rows.length === 0) return;

  const payload = JSON.stringify({
    title: "Donkai",
    body,
    kind,
    ticketKey,
    url: ticketKey ? `/ticket/${ticketKey}` : "/",
  });

  for (const row of rows) {
    const sub = { endpoint: row.endpoint, keys: JSON.parse(row.keys_json) };
    webpush.sendNotification(sub, payload).catch((err: { statusCode?: number }) => {
      // 404/410 = subscription gone; prune it.
      if (err?.statusCode === 404 || err?.statusCode === 410) {
        removeSubscription(row.endpoint);
      } else {
        logEvent(ticketKey, "push_failed", { error: String(err) });
      }
    });
  }
}
