import { Hono, type MiddlewareHandler } from "hono";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { z } from "zod";
import { config } from "../config.js";
import { bearerAuth } from "../api/server.js";
import {
  answerBlocked,
  getCosts,
  getStatus,
  getTicketDetail,
  listQueueWithPositions,
  pause,
  reorderQueue,
  resume,
  retryTicket,
  tailLog,
} from "../control/actions.js";
import { addRule, deleteRule, listRules, updateRule } from "../control/rules.js";
import { appUuidForRepo, triggerRedeploy } from "../orchestrator/coolify.js";

function text(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

// Fresh server + transport per request: stateless streamable HTTP, no session
// bookkeeping — right size for a single-user connector.
function buildServer(): McpServer {
  const server = new McpServer({ name: "donkai", version: "1.0.0" });

  server.tool(
    "donkai_status",
    "Current Donkai status: paused flag, active workers with their statuses, queue length, today's spend.",
    {},
    async () => text(getStatus()),
  );

  server.tool(
    "donkai_list_queue",
    "Pending ticket queue in scheduling order (position, priority, repo).",
    {},
    async () => text(listQueueWithPositions()),
  );

  server.tool(
    "donkai_reorder_queue",
    "Reorder the pending queue. Pass ticket keys in the desired order; named tickets move to the front in that order, the rest keep priority ordering behind them.",
    { order: z.array(z.string()).describe("Ticket keys, first = next to run") },
    async ({ order }) => text(reorderQueue(order)),
  );

  server.tool(
    "donkai_pause",
    "Pause automatic processing: no new ticket pickups or worker starts. In-flight workers and deploy pipelines continue.",
    {},
    async () => {
      pause();
      return text("Paused. In-flight work continues; no new pickups.");
    },
  );

  server.tool("donkai_resume", "Resume automatic ticket processing.", {}, async () => {
    resume();
    return text("Resumed.");
  });

  server.tool(
    "donkai_ticket",
    "Detail for one ticket: session status, pending question, PR URLs, queue position, recent log lines.",
    {
      key: z.string().describe("Ticket key, e.g. ENG-42"),
      logLines: z.number().optional().describe("How many log lines to include (default 20)"),
    },
    async ({ key, logLines }) => {
      const detail = getTicketDetail(key);
      if (!detail) return text(`No session for ${key}`);
      const logs = tailLog(key, { tail: logLines ?? 20 });
      return text({ ...detail, recentLog: logs?.lines ?? [] });
    },
  );

  server.tool(
    "donkai_answer_blocked",
    "Answer a worker that is blocked waiting for human input (suspended_local). The worker resumes with your answer.",
    {
      key: z.string(),
      answer: z.string().describe("Your answer/instruction to the blocked worker"),
    },
    async ({ key, answer }) =>
      text(
        answerBlocked(key, answer)
          ? `Queued — ${key} will resume with your answer shortly.`
          : `${key} is not awaiting a dashboard answer.`,
      ),
  );

  server.tool(
    "donkai_retry",
    "Re-enqueue an errored ticket so it is picked up again.",
    { key: z.string() },
    async ({ key }) =>
      text(retryTicket(key) ? `${key} re-queued.` : `${key} is not in error state.`),
  );

  server.tool(
    "donkai_costs",
    "Token spend aggregates: per day and per ticket (USD).",
    { days: z.number().optional().describe("Days of history (default 30)") },
    async ({ days }) => text(getCosts(days ?? 30)),
  );

  server.tool(
    "donkai_set_pickup_rules",
    "Manage auto-pickup criteria. A ready ticket is picked up when ANY enabled rule matches ALL its set fields. No rules = pick up everything eligible. Actions: list | add | remove | toggle.",
    {
      action: z.enum(["list", "add", "remove", "toggle"]),
      rule: z
        .object({
          team_key: z.string().optional(),
          label: z.string().optional(),
          max_priority_num: z
            .number()
            .optional()
            .describe("Linear priority: 1=Urgent..4=Low; rule matches priority <= this"),
          repo: z.string().optional(),
          note: z.string().optional(),
        })
        .optional()
        .describe("Rule fields (for add)"),
      id: z.number().optional().describe("Rule id (for remove/toggle)"),
    },
    async ({ action, rule, id }) => {
      switch (action) {
        case "list":
          return text(listRules());
        case "add":
          return text(addRule(rule ?? {}));
        case "remove":
          return text(id != null && deleteRule(id) ? `Rule ${id} removed.` : "Rule not found.");
        case "toggle": {
          if (id == null) return text("id required");
          const current = listRules().find((r) => r.id === id);
          if (!current) return text("Rule not found.");
          return text(updateRule(id, { enabled: !current.enabled }));
        }
      }
    },
  );

  server.tool(
    "donkai_deploy",
    "Trigger a Coolify redeploy for a repo's DEV or PROD app (uses COOLIFY_APP_<REPO>_<ENV> env mapping).",
    { repo: z.string(), env: z.enum(["DEV", "PROD"]) },
    async ({ repo, env }) => {
      const uuid = appUuidForRepo(repo, env);
      if (!uuid) return text(`No COOLIFY_APP_* mapping for ${repo} ${env}.`);
      const outcome = await triggerRedeploy(uuid);
      return text(outcome);
    },
  );

  return server;
}

async function handleMcp(c: Parameters<MiddlewareHandler>[0]): Promise<Response> {
  const server = buildServer();
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return (await transport.handleRequest(c)) ?? c.text("bad request", 400);
}

export function buildMcp(): Hono {
  const app = new Hono();

  // Header-capable clients (Claude Code, API): bearer token at /mcp.
  app.all("/", bearerAuth(), (c) => handleMcp(c));

  // claude.ai custom connectors can't send auth headers (OAuth-only UI), so a
  // 32+ byte random path segment acts as the credential. Treat the URL as a
  // secret. Set MCP_PATH_SECRET to enable.
  app.all("/:secret", async (c, next) => {
    const secret = config.mcp.pathSecret;
    if (!secret) return next();
    const provided = Buffer.from(c.req.param("secret"));
    const expected = Buffer.from(secret);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return next();
    }
    return handleMcp(c);
  });

  return app;
}
