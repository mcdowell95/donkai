import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";

function expand(p: string): string {
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

const csv = (v: string | undefined): string[] =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const Concurrency = z.enum(["parallel", "sequential", "sequential_per_repo"]);
const Autonomy = z.enum(["review_only", "auto_merge_on_green", "full_yolo"]);
const RepoInference = z.enum(["label_prefix", "project", "first_line"]);
const Workflow = z.enum(["direct_main", "staging_promote"]);
const HarvestMode = z.enum(["piggyback", "separate", "off"]);

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v.trim();
}

export const config = (() => {
  const teamKeys = csv(process.env.LINEAR_TEAM_KEYS);
  if (teamKeys.length === 0) {
    throw new Error("LINEAR_TEAM_KEYS must list at least one Linear team key, e.g. ENG,DATA");
  }

  return {
    linear: {
      apiKey: required("LINEAR_API_KEY"),
      teamKeys,
      pickupLabel: (process.env.LINEAR_PICKUP_LABEL ?? "").trim(),
    },
    states: {
      ready: process.env.STATE_READY ?? "Ready for Claude",
      inProgress: process.env.STATE_IN_PROGRESS ?? "In Progress",
      waiting: process.env.STATE_WAITING ?? "Waiting for human",
      review: process.env.STATE_REVIEW ?? "Review",
      done: process.env.STATE_DONE ?? "Done",
    },
    // With a Linear webhook configured the poll is reconciliation-only, so the
    // default interval stretches; without one it stays the primary pickup path.
    pollIntervalMs:
      Number(
        process.env.POLL_INTERVAL_SECS ??
          (process.env.LINEAR_WEBHOOK_SECRET ? "300" : "60"),
      ) * 1000,
    workspaceRoot: expand(process.env.DONKAI_WORKSPACE_ROOT ?? "~/donkai-workers"),
    dbPath: expand(process.env.DONKAI_DB_PATH ?? "~/donkai-workers/donkai.sqlite"),
    workerClaudeMd: expand(process.env.WORKER_CLAUDE_MD_PATH ?? "./worker-CLAUDE.md"),
    workerClaudeMdCompressed: process.env.WORKER_CLAUDE_MD_COMPRESSED_PATH
      ? expand(process.env.WORKER_CLAUDE_MD_COMPRESSED_PATH)
      : "",
    workerMcpJson: expand(process.env.WORKER_MCP_JSON_PATH ?? "./worker-mcp.json"),
    mcpAlwaysServers: csv(process.env.MCP_ALWAYS_SERVERS),
    claudeModel: process.env.CLAUDE_MODEL ?? "claude-opus-4-7",
    claudeCodeExecutable: (process.env.CLAUDE_CODE_EXECUTABLE ?? "").trim(),
    workerTimeoutMs: Number(process.env.WORKER_TIMEOUT_SECS ?? "1800") * 1000,
    harvest: {
      mode: HarvestMode.parse(process.env.HARVEST_MODE ?? "piggyback"),
      model: process.env.HARVEST_MODEL ?? "claude-haiku-4-5",
    },
    gitRemoteBase: (process.env.GIT_REMOTE_BASE ?? "").replace(/\/$/, ""),
    tier2Keywords: csv(process.env.TIER2_KEYWORDS).map((s) => s.toLowerCase()),
    concurrency: {
      mode: Concurrency.parse(process.env.CONCURRENCY_MODE ?? "parallel"),
      maxConcurrent: Number(process.env.MAX_CONCURRENT_WORKERS ?? "3"),
      repoInference: RepoInference.parse(process.env.REPO_INFERENCE ?? "label_prefix"),
    },
    autonomy: {
      level: Autonomy.parse(process.env.AUTONOMY_LEVEL ?? "review_only"),
      repoAllowlist: csv(process.env.AUTO_MERGE_REPOS_ALLOWLIST),
      maxFilesChanged: Number(process.env.AUTO_MERGE_MAX_FILES_CHANGED ?? "20"),
      maxLinesChanged: Number(process.env.AUTO_MERGE_MAX_LINES_CHANGED ?? "500"),
      requireLabel: process.env.AUTO_MERGE_REQUIRE_LABEL ?? "claude-auto",
      blockPaths: csv(process.env.AUTO_MERGE_BLOCK_PATHS),
      blockKeywords: csv(process.env.AUTO_MERGE_BLOCK_KEYWORDS).map((s) => s.toLowerCase()),
      ciRetries: Number(process.env.AUTO_MERGE_CI_RETRIES ?? "3"),
    },
    workflow: {
      mode: Workflow.parse(process.env.WORKFLOW_MODE ?? "direct_main"),
      devBranch: process.env.DEV_BRANCH ?? "dev",
      mainBranch: process.env.MAIN_BRANCH ?? "main",
      devDeployCheck: process.env.DEV_DEPLOY_CHECK ?? "build-and-push",
      mainDeployCheck:
        process.env.MAIN_DEPLOY_CHECK ?? process.env.DEV_DEPLOY_CHECK ?? "build-and-push",
      devDeployPollSecs: Number(process.env.DEV_DEPLOY_POLL_SECS ?? "30"),
    },
    coolify: {
      baseUrl: (process.env.COOLIFY_BASE_URL ?? "").replace(/\/$/, ""),
      apiToken: process.env.COOLIFY_API_TOKEN ?? "",
      deployTimeoutSecs: Number(process.env.COOLIFY_DEPLOY_TIMEOUT_SECS ?? "1200"),
    },
    dashboard: {
      host: process.env.DASHBOARD_HOST ?? "127.0.0.1",
      port: Number(process.env.DASHBOARD_PORT ?? "8346"),
      token: process.env.DASHBOARD_TOKEN ?? "",
      subtitle: process.env.DASHBOARD_SUBTITLE ?? "",
    },
    api: {
      authToken: (process.env.DONKAI_AUTH_TOKEN ?? "").trim(),
      publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, ""),
    },
    mcp: {
      pathSecret: (process.env.MCP_PATH_SECRET ?? "").trim(),
    },
    webhooks: {
      linearSecret: (process.env.LINEAR_WEBHOOK_SECRET ?? "").trim(),
    },
    push: {
      vapidPublicKey: (process.env.VAPID_PUBLIC_KEY ?? "").trim(),
      vapidPrivateKey: (process.env.VAPID_PRIVATE_KEY ?? "").trim(),
      vapidSubject: (process.env.VAPID_SUBJECT ?? "mailto:donkai@example.com").trim(),
    },
  };
})();

export type AppConfig = typeof config;
export type ConcurrencyMode = z.infer<typeof Concurrency>;
export type AutonomyLevel = z.infer<typeof Autonomy>;
export type RepoInferenceMode = z.infer<typeof RepoInference>;
export type WorkflowMode = z.infer<typeof Workflow>;
export type HarvestModeName = z.infer<typeof HarvestMode>;
