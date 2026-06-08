import "dotenv/config";
import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { startOrchestrator } from "./orchestrator/loop.js";
import { buildDashboard } from "./dashboard/server.js";

console.log(`
╔══════════════════════════════════════════════════╗
║   Donkai — donkey-work AI                        ║
║   Teams: ${config.linear.teamKeys.join(", ").padEnd(40)}║
║   Dashboard: http://${config.dashboard.host}:${String(config.dashboard.port).padEnd(28)}║
║   Ctrl+C to stop                                 ║
╚══════════════════════════════════════════════════╝
`);

const app = buildDashboard();
serve(
  { fetch: app.fetch, hostname: config.dashboard.host, port: config.dashboard.port },
  (info) => console.log(`Dashboard listening on http://${info.address}:${info.port}`),
);

startOrchestrator().catch((err) => {
  console.error("Fatal orchestrator error:", err);
  process.exit(1);
});
