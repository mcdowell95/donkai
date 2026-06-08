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
    },
    states: {
      ready: process.env.STATE_READY ?? "Ready for Claude",
      inProgress: process.env.STATE_IN_PROGRESS ?? "In Progress",
      waiting: process.env.STATE_WAITING ?? "Waiting for human",
      review: process.env.STATE_REVIEW ?? "Review",
      done: process.env.STATE_DONE ?? "Done",
    },
    pollIntervalMs: Number(process.env.POLL_INTERVAL_SECS ?? "60") * 1000,
    workspaceRoot: expand(process.env.DONKAI_WORKSPACE_ROOT ?? "~/donkai-workers"),
    dbPath: expand(process.env.DONKAI_DB_PATH ?? "~/donkai-workers/donkai.sqlite"),
    workerClaudeMd: expand(process.env.WORKER_CLAUDE_MD_PATH ?? "./worker-CLAUDE.md"),
    claudeModel: process.env.CLAUDE_MODEL ?? "claude-opus-4-7",
    workerTimeoutMs: Number(process.env.WORKER_TIMEOUT_SECS ?? "1800") * 1000,
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
    dashboard: {
      host: process.env.DASHBOARD_HOST ?? "127.0.0.1",
      port: Number(process.env.DASHBOARD_PORT ?? "8346"),
      token: process.env.DASHBOARD_TOKEN ?? "",
      subtitle: process.env.DASHBOARD_SUBTITLE ?? "",
    },
  };
})();

export type AppConfig = typeof config;
export type ConcurrencyMode = z.infer<typeof Concurrency>;
export type AutonomyLevel = z.infer<typeof Autonomy>;
export type RepoInferenceMode = z.infer<typeof RepoInference>;
