import { config } from "../config.js";

export type CoolifyDeploymentStatus =
  | "queued"
  | "in_progress"
  | "running"
  | "finished"
  | "success"
  | "failed"
  | "cancelled"
  | "unknown";

export type DeployEnv = "DEV" | "PROD";

// Look up Coolify application UUID for a repo + environment via env vars.
// Naming: COOLIFY_APP_<REPO>_<ENV> with repo uppercased and `-`/`.` → `_`.
export function appUuidForRepo(repo: string, env: DeployEnv): string | null {
  const sanitized = repo
    .toUpperCase()
    .replace(/[-./]/g, "_")
    .replace(/[^A-Z0-9_]/g, "");
  const varName = `COOLIFY_APP_${sanitized}_${env}`;
  const uuid = process.env[varName];
  return uuid && uuid.trim() ? uuid.trim() : null;
}

function authHeaders(): Record<string, string> {
  if (!config.coolify.apiToken) {
    throw new Error("COOLIFY_API_TOKEN is not set");
  }
  return {
    Authorization: `Bearer ${config.coolify.apiToken}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

function baseUrl(): string {
  if (!config.coolify.baseUrl) {
    throw new Error("COOLIFY_BASE_URL is not set");
  }
  return config.coolify.baseUrl;
}

export interface TriggerOutcome {
  ok: boolean;
  deploymentUuid: string | null;
  reason?: string;
}

// Trigger a redeploy of the given Coolify application. Returns the
// deployment UUID for status polling. On any failure (network, auth,
// missing UUID) returns ok=false with a reason.
export async function triggerRedeploy(appUuid: string): Promise<TriggerOutcome> {
  try {
    const url = `${baseUrl()}/api/v1/deploy?uuid=${encodeURIComponent(appUuid)}&force=false`;
    const res = await fetch(url, { method: "POST", headers: authHeaders() });
    if (!res.ok) {
      return {
        ok: false,
        deploymentUuid: null,
        reason: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`,
      };
    }
    const data = (await res.json()) as {
      deployments?: Array<{ deployment_uuid?: string; resource_uuid?: string }>;
    };
    const deploymentUuid =
      data.deployments?.[0]?.deployment_uuid ??
      data.deployments?.[0]?.resource_uuid ??
      null;
    return { ok: true, deploymentUuid };
  } catch (err) {
    return {
      ok: false,
      deploymentUuid: null,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function getDeploymentStatus(
  deploymentUuid: string,
): Promise<CoolifyDeploymentStatus> {
  try {
    const url = `${baseUrl()}/api/v1/deployments/${encodeURIComponent(deploymentUuid)}`;
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) return "unknown";
    const data = (await res.json()) as { status?: string };
    return normalizeStatus(data.status);
  } catch {
    return "unknown";
  }
}

function normalizeStatus(raw: string | undefined): CoolifyDeploymentStatus {
  if (!raw) return "unknown";
  const s = raw.toLowerCase();
  // Coolify versions disagree on terminology; map both common shapes.
  if (s === "finished" || s === "success" || s === "succeeded") return "finished";
  if (s === "failed" || s === "error") return "failed";
  if (s === "cancelled" || s === "canceled") return "cancelled";
  if (s === "in_progress" || s === "running") return "in_progress";
  if (s === "queued" || s === "pending") return "queued";
  return "unknown";
}

export function isTerminal(status: CoolifyDeploymentStatus): boolean {
  return status === "finished" || status === "failed" || status === "cancelled";
}
