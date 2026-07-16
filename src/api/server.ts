import { Hono, type MiddlewareHandler } from "hono";
import { timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { db } from "../registry/db.js";
import { listSessions } from "../registry/sessions.js";
import {
  answerBlocked,
  getCosts,
  getStatus,
  getTicketDetail,
  listQueueWithPositions,
  pause,
  reorderQueue,
  requestRelease,
  requestTakeover,
  resume,
  retryTicket,
  tailLog,
} from "../control/actions.js";
import { addRule, deleteRule, listRules, updateRule } from "../control/rules.js";
import { removeSubscription, saveSubscription, type PushSubscriptionJson } from "./push.js";

function tokenMatches(provided: string): boolean {
  const expected = config.api.authToken;
  if (!expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function bearerAuth(): MiddlewareHandler {
  return async (c, next) => {
    if (!config.api.authToken) {
      return c.text("API disabled: DONKAI_AUTH_TOKEN not set", 503);
    }
    const header = c.req.header("authorization") ?? "";
    const token = /^bearer /i.test(header) ? header.slice(7) : "";
    if (!tokenMatches(token)) return c.text("Unauthorized", 401);
    await next();
  };
}

export function buildApi(): Hono {
  const app = new Hono();
  app.use("*", bearerAuth());

  // --- Reads ---

  app.get("/status", (c) => c.json(getStatus()));

  app.get("/sessions", (c) => c.json(listSessions()));

  app.get("/sessions/:key", (c) => {
    const detail = getTicketDetail(c.req.param("key"));
    return detail ? c.json(detail) : c.json({ error: "not found" }, 404);
  });

  app.get("/sessions/:key/logs", (c) => {
    const tail = Number(c.req.query("tail") ?? "200");
    const afterRaw = c.req.query("after");
    const result = tailLog(c.req.param("key"), {
      tail,
      after: afterRaw != null ? Number(afterRaw) : undefined,
    });
    return result ? c.json(result) : c.json({ error: "not found" }, 404);
  });

  app.get("/queue", (c) => c.json(listQueueWithPositions()));

  app.get("/costs", (c) => c.json(getCosts(Number(c.req.query("days") ?? "30"))));

  app.get("/events", (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? "100"), 500);
    const ticket = c.req.query("ticket");
    const rows = ticket
      ? db()
          .prepare("SELECT * FROM events WHERE ticket_key = ? ORDER BY id DESC LIMIT ?")
          .all(ticket, limit)
      : db().prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit);
    return c.json(rows);
  });

  app.get("/learnings", (c) =>
    c.json(
      db()
        .prepare("SELECT * FROM learnings_pending WHERE status = 'pending' ORDER BY created_at DESC")
        .all(),
    ),
  );

  app.get("/rules", (c) => c.json(listRules()));

  app.get("/push/vapid-public-key", (c) =>
    c.json({ key: config.push.vapidPublicKey || null }),
  );

  // --- Mutations ---

  app.post("/pause", (c) => {
    pause();
    return c.json({ paused: true });
  });

  app.post("/resume", (c) => {
    resume();
    return c.json({ paused: false });
  });

  app.put("/queue/order", async (c) => {
    const body = (await c.req.json()) as { order?: string[] };
    if (!Array.isArray(body.order)) return c.json({ error: "order must be an array" }, 400);
    return c.json(reorderQueue(body.order));
  });

  app.post("/rules", async (c) => {
    const body = (await c.req.json()) as Parameters<typeof addRule>[0];
    return c.json(addRule(body), 201);
  });

  app.put("/rules/:id", async (c) => {
    const body = (await c.req.json()) as Parameters<typeof updateRule>[1];
    const updated = updateRule(Number(c.req.param("id")), body);
    return updated ? c.json(updated) : c.json({ error: "not found" }, 404);
  });

  app.delete("/rules/:id", (c) =>
    deleteRule(Number(c.req.param("id")))
      ? c.json({ deleted: true })
      : c.json({ error: "not found" }, 404),
  );

  app.post("/sessions/:key/respond", async (c) => {
    const body = (await c.req.json()) as { text?: string };
    const text = (body.text ?? "").trim();
    if (!text) return c.json({ error: "text required" }, 400);
    const ok = answerBlocked(c.req.param("key"), text);
    return ok
      ? c.json({ queued: true })
      : c.json({ error: "ticket is not awaiting a dashboard response" }, 409);
  });

  app.post("/sessions/:key/takeover", (c) => {
    requestTakeover(c.req.param("key"));
    return c.json({ queued: true });
  });

  app.post("/sessions/:key/release", (c) => {
    requestRelease(c.req.param("key"));
    return c.json({ queued: true });
  });

  app.post("/sessions/:key/retry", (c) =>
    retryTicket(c.req.param("key"))
      ? c.json({ queued: true })
      : c.json({ error: "ticket is not in error state" }, 409),
  );

  app.post("/learnings/:id/accept", (c) => {
    db()
      .prepare("UPDATE learnings_pending SET status = 'accepted' WHERE id = ?")
      .run(Number(c.req.param("id")));
    return c.json({ ok: true });
  });

  app.post("/learnings/:id/reject", (c) => {
    db()
      .prepare("UPDATE learnings_pending SET status = 'rejected' WHERE id = ?")
      .run(Number(c.req.param("id")));
    return c.json({ ok: true });
  });

  app.post("/push/subscribe", async (c) => {
    const sub = (await c.req.json()) as PushSubscriptionJson;
    if (!sub?.endpoint || !sub?.keys?.p256dh) return c.json({ error: "invalid subscription" }, 400);
    saveSubscription(sub);
    return c.json({ ok: true });
  });

  app.delete("/push/subscribe", async (c) => {
    const body = (await c.req.json()) as { endpoint?: string };
    if (!body.endpoint) return c.json({ error: "endpoint required" }, 400);
    removeSubscription(body.endpoint);
    return c.json({ ok: true });
  });

  return app;
}
