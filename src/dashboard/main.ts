import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { config } from "../config.js";
import { buildDashboard } from "./server.js";

// Views link with /classic-prefixed URLs (shared with the combined entrypoint),
// so the standalone dashboard mounts under /classic too.
const app = new Hono();
app.get("/", (c) => c.redirect("/classic"));
app.route("/classic", buildDashboard());

serve(
  { fetch: app.fetch, hostname: config.dashboard.host, port: config.dashboard.port },
  (info) => {
    console.log(`Dashboard listening on http://${info.address}:${info.port}/classic/`);
  },
);
