import "dotenv/config";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { startOrchestrator } from "./orchestrator/loop.js";
import { buildDashboard } from "./dashboard/server.js";
import { buildApi } from "./api/server.js";
import { buildMcp } from "./mcp/server.js";
import { buildLinearWebhook } from "./webhooks/linear.js";
import { db } from "./registry/db.js";
import { lastTickAt } from "./control/settings.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

console.log(`
╔══════════════════════════════════════════════════╗
║   Donkai — donkey-work AI                        ║
║   Teams: ${config.linear.teamKeys.join(", ").padEnd(40)}║
║   Dashboard: http://${config.dashboard.host}:${String(config.dashboard.port).padEnd(28)}║
║   Ctrl+C to stop                                 ║
╚══════════════════════════════════════════════════╝
`);

const app = new Hono();

// Liveness + orchestrator heartbeat. A crashed loop with a live HTTP server
// must read as unhealthy: stale last_tick_at is the tell.
app.get("/healthz", (c) => {
  let dbOk = true;
  try {
    db().prepare("SELECT 1").get();
  } catch {
    dbOk = false;
  }
  const tick = lastTickAt();
  const tickAgeMs = tick ? Date.now() - new Date(tick).getTime() : null;
  const stale = tickAgeMs == null || tickAgeMs > Math.max(config.pollIntervalMs * 3, 120_000);
  const ok = dbOk && !stale;
  return c.json({ ok, dbOk, lastTickAt: tick, tickAgeMs }, ok ? 200 : 503);
});

app.route("/api/v1", buildApi());
app.route("/mcp", buildMcp());
app.route("/webhooks", buildLinearWebhook());

// Original HTMX dashboard lives on at /classic.
app.get("/classic/", (c) => c.redirect("/classic"));
app.route("/classic", buildDashboard());

// PWA static bundle (built by `pnpm --dir src/pwa build`). Falls back to a
// pointer page when the bundle hasn't been built.
const pwaDist = join(__dirname, "pwa", "dist");
if (existsSync(pwaDist)) {
  const root = relative(process.cwd(), pwaDist) || ".";
  app.use("/assets/*", serveStatic({ root }));
  app.use("/manifest.webmanifest", serveStatic({ root }));
  app.use("/sw.js", serveStatic({ root }));
  app.use("/registerSW.js", serveStatic({ root }));
  app.use("/push-sw.js", serveStatic({ root }));
  app.use("/workbox-*", serveStatic({ root }));
  app.use("/icons/*", serveStatic({ root }));
  // SPA fallback: any other GET serves index.html so client routing works.
  app.get("*", serveStatic({ root, rewriteRequestPath: () => "/index.html" }));
} else {
  app.get("/", (c) =>
    c.html(
      `<html><body style="font-family:system-ui;padding:2rem">
        <h1>Donkai</h1>
        <p>PWA bundle not built. Classic dashboard: <a href="/classic">/classic</a></p>
      </body></html>`,
    ),
  );
}

serve(
  { fetch: app.fetch, hostname: config.dashboard.host, port: config.dashboard.port },
  (info) => console.log(`Donkai listening on http://${info.address}:${info.port}`),
);

startOrchestrator().catch((err) => {
  console.error("Fatal orchestrator error:", err);
  process.exit(1);
});
