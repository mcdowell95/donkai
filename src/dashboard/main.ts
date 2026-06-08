import "dotenv/config";
import { serve } from "@hono/node-server";
import { config } from "../config.js";
import { buildDashboard } from "./server.js";

const app = buildDashboard();
serve(
  { fetch: app.fetch, hostname: config.dashboard.host, port: config.dashboard.port },
  (info) => {
    console.log(`Dashboard listening on http://${info.address}:${info.port}`);
  },
);
