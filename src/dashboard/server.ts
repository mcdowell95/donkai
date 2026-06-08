import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { db } from "../registry/db.js";
import { getSession, listSessions } from "../registry/sessions.js";
import { pushSignal } from "../ipc/signals.js";
import { listQueue } from "../orchestrator/queue.js";
import { layout, escape } from "./views/layout.js";
import { workerCards } from "./views/cards.js";
import { renderLogFragment } from "./views/logs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function buildDashboard(): Hono {
  const app = new Hono();

  if (config.dashboard.token) {
    app.use("*", async (c, next) => {
      const auth = c.req.header("authorization") ?? "";
      const expected =
        "Basic " + Buffer.from(`donkai:${config.dashboard.token}`).toString("base64");
      if (auth !== expected) {
        c.header("WWW-Authenticate", 'Basic realm="Donkai"');
        return c.text("Unauthorized", 401);
      }
      await next();
    });
  }

  // serveStatic root is interpreted relative to process.cwd(), so compute it
  const staticRoot = relative(process.cwd(), resolve(__dirname));
  app.use("/static/*", serveStatic({ root: staticRoot || "." }));

  app.get("/", (c) => {
    const sessions = listSessions();
    const body = `
      <section
        hx-get="/fragments/workers"
        hx-trigger="every 3s"
        hx-target="this"
        hx-swap="innerHTML">
        ${workerCards(sessions)}
      </section>`;
    return c.html(layout("Workers", body, "home"));
  });

  app.get("/fragments/workers", (c) => c.html(workerCards(listSessions())));

  app.get("/logs/:key", (c) => {
    const key = c.req.param("key");
    const s = getSession(key);
    if (!s) {
      return c.html(layout("Logs", `<p class="empty">No session for ${escape(key)}.</p>`, "home"));
    }
    const header = `
      <div class="log-header">
        <h2>${escape(key)} — ${escape(s.summary ?? "")}</h2>
        <div class="log-sub">workspace: <code>${escape(s.workspace_dir ?? "(none)")}</code> · status: <span class="status">${escape(s.status)}</span></div>
        <a class="tab" href="/">← back</a>
      </div>
      <section
        class="log-stream"
        hx-get="/fragments/logs/${escape(key)}"
        hx-trigger="load, every 2s"
        hx-target="this"
        hx-swap="innerHTML">
        <p class="empty">Loading…</p>
      </section>`;
    return c.html(layout(`Logs — ${key}`, header, "home"));
  });

  app.get("/fragments/logs/:key", (c) => {
    const key = c.req.param("key");
    const s = getSession(key);
    return c.html(renderLogFragment(s?.workspace_dir ?? null));
  });

  app.get("/queue", (c) => {
    const rows = listQueue();
    const body =
      rows.length === 0
        ? `<p class="empty">Queue empty.</p>`
        : `<table class="grid">
            <thead><tr><th>#</th><th>Ticket</th><th>Repo</th><th>Priority</th><th>Queued</th></tr></thead>
            <tbody>${rows
              .map(
                (r, i) =>
                  `<tr><td>${i + 1}</td><td>${escape(r.ticket_key)}</td><td>${escape(r.repo ?? "—")}</td><td>${r.priority ?? "—"}</td><td>${escape(r.created_at)}</td></tr>`,
              )
              .join("")}</tbody>
          </table>`;
    return c.html(layout("Queue", body, "queue"));
  });

  app.get("/merges", (c) => {
    interface MergeRow {
      ticket_key: string;
      pr_url: string;
      merged_at: string;
      files_changed: number | null;
      lines_changed: number | null;
      guards_passed: string;
    }
    const rows = db()
      .prepare<[], MergeRow>("SELECT * FROM merges ORDER BY merged_at DESC LIMIT 100")
      .all();
    const body =
      rows.length === 0
        ? `<p class="empty">No auto-merges recorded yet.</p>`
        : `<table class="grid">
            <thead><tr><th>Ticket</th><th>PR</th><th>Files</th><th>Lines</th><th>Guards</th><th>Merged at</th></tr></thead>
            <tbody>${rows
              .map(
                (r) =>
                  `<tr><td>${escape(r.ticket_key)}</td><td><a href="${escape(r.pr_url ?? "")}" target="_blank">PR ↗</a></td><td>${r.files_changed ?? "—"}</td><td>${r.lines_changed ?? "—"}</td><td><code>${escape(r.guards_passed)}</code></td><td>${escape(r.merged_at)}</td></tr>`,
              )
              .join("")}</tbody>
          </table>`;
    return c.html(layout("Merges", body, "merges"));
  });

  app.get("/learnings", (c) => {
    interface LearningRow {
      id: number;
      ticket_key: string;
      proposal: string;
      status: string;
      created_at: string;
    }
    const rows = db()
      .prepare<[], LearningRow>(
        "SELECT * FROM learnings_pending WHERE status = 'pending' ORDER BY created_at DESC",
      )
      .all();
    const items = rows
      .map((r) => {
        const parsed = JSON.parse(r.proposal) as { proposal: string; section: string };
        return `<article class="card">
          <header><span class="ticket">${escape(r.ticket_key)}</span><span class="status">${escape(parsed.section)}</span></header>
          <pre>${escape(parsed.proposal)}</pre>
          <footer>
            <form hx-post="/api/learnings/${r.id}/accept" hx-target="closest .card" hx-swap="outerHTML">
              <button>Accept</button>
            </form>
            <form hx-post="/api/learnings/${r.id}/reject" hx-target="closest .card" hx-swap="outerHTML">
              <button>Reject</button>
            </form>
          </footer>
        </article>`;
      })
      .join("");
    const body =
      rows.length === 0 ? `<p class="empty">No pending learnings.</p>` : `<div class="cards">${items}</div>`;
    return c.html(layout("Learnings", body, "learnings"));
  });

  app.get("/costs", (c) => {
    interface DailyRow { day: string; cost: number; tickets: number }
    interface TicketRow { ticket_key: string; total: number; rows: number }
    const daily = db()
      .prepare<[], DailyRow>(
        `SELECT substr(created_at, 1, 10) AS day,
                SUM(COALESCE(cost_usd, 0)) AS cost,
                COUNT(DISTINCT ticket_key) AS tickets
           FROM costs
          GROUP BY day
          ORDER BY day DESC
          LIMIT 30`,
      )
      .all();
    const perTicket = db()
      .prepare<[], TicketRow>(
        `SELECT ticket_key,
                SUM(COALESCE(cost_usd, 0)) AS total,
                COUNT(*) AS rows
           FROM costs
          GROUP BY ticket_key
          ORDER BY total DESC
          LIMIT 50`,
      )
      .all();
    const body = `
      <h2>Daily</h2>
      <table class="grid"><thead><tr><th>Day</th><th>Tickets</th><th>USD</th></tr></thead>
      <tbody>${daily.map((r) => `<tr><td>${escape(r.day)}</td><td>${r.tickets}</td><td>$${r.cost.toFixed(4)}</td></tr>`).join("") || `<tr><td colspan="3" class="empty">No cost data.</td></tr>`}</tbody></table>
      <h2>Per ticket</h2>
      <table class="grid"><thead><tr><th>Ticket</th><th>Calls</th><th>USD</th></tr></thead>
      <tbody>${perTicket.map((r) => `<tr><td>${escape(r.ticket_key)}</td><td>${r.rows}</td><td>$${r.total.toFixed(4)}</td></tr>`).join("") || `<tr><td colspan="3" class="empty">No cost data.</td></tr>`}</tbody></table>`;
    return c.html(layout("Costs", body, "costs"));
  });

  app.get("/events", (c) => {
    interface EventRow {
      id: number;
      ticket_key: string | null;
      kind: string;
      detail: string | null;
      created_at: string;
    }
    const rows = db()
      .prepare<[], EventRow>("SELECT * FROM events ORDER BY id DESC LIMIT 200")
      .all();
    const body = `<table class="grid">
      <thead><tr><th>When</th><th>Ticket</th><th>Kind</th><th>Detail</th></tr></thead>
      <tbody>${rows
        .map(
          (r) =>
            `<tr><td>${escape(r.created_at)}</td><td>${escape(r.ticket_key ?? "—")}</td><td>${escape(r.kind)}</td><td><code>${escape(r.detail ?? "")}</code></td></tr>`,
        )
        .join("")}</tbody>
    </table>`;
    return c.html(layout("Events", body, "events"));
  });

  // --- API endpoints (HTMX-driven) ---
  app.post("/api/respond/:key", async (c) => {
    const key = c.req.param("key");
    const form = await c.req.parseBody();
    const response = String(form.response ?? "").trim();
    if (response) pushSignal(key, "response", response);
    return c.html(`<article class="card"><p>Response queued — orchestrator will resume ${escape(key)} shortly.</p></article>`);
  });

  app.post("/api/takeover/:key", (c) => {
    pushSignal(c.req.param("key"), "takeover");
    return c.html(`<article class="card"><p>Takeover requested for ${escape(c.req.param("key"))}.</p></article>`);
  });

  app.post("/api/release/:key", (c) => {
    pushSignal(c.req.param("key"), "release");
    return c.html(`<article class="card"><p>Release queued for ${escape(c.req.param("key"))}.</p></article>`);
  });

  app.post("/api/learnings/:id/accept", (c) => {
    const id = Number(c.req.param("id"));
    db().prepare("UPDATE learnings_pending SET status = 'accepted' WHERE id = ?").run(id);
    return c.html(`<article class="card"><p>Accepted — paste the proposal into worker-CLAUDE.md and commit manually.</p></article>`);
  });

  app.post("/api/learnings/:id/reject", (c) => {
    const id = Number(c.req.param("id"));
    db().prepare("UPDATE learnings_pending SET status = 'rejected' WHERE id = ?").run(id);
    return c.html(`<article class="card"><p>Rejected.</p></article>`);
  });

  return app;
}
