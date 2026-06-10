import { execFileSync } from "node:child_process";

export type CheckConclusion =
  | "success"
  | "failure"
  | "cancelled"
  | "timed_out"
  | "action_required"
  | "neutral"
  | "skipped"
  | "stale"
  | "startup_failure"
  | "pending"
  | "missing";

interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

function ghJson<T>(args: string[], cwd?: string): T | null {
  try {
    const out = execFileSync("gh", args, {
      encoding: "utf-8",
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(out) as T;
  } catch {
    return null;
  }
}

function ghText(args: string[], cwd?: string): string | null {
  try {
    return execFileSync("gh", args, {
      encoding: "utf-8",
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

export interface MergeFeatureOutcome {
  merged: boolean;
  mergeSha: string | null;
  reason?: string;
}

// Squash-merge a feature PR. Returns the resulting merge commit SHA on the
// base branch so callers can poll deploy checks against it.
export function mergeFeaturePr(
  prUrl: string,
  cwd: string,
): MergeFeatureOutcome {
  try {
    execFileSync(
      "gh",
      ["pr", "merge", prUrl, "--squash", "--delete-branch", "--admin"],
      { cwd, stdio: "inherit" },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { merged: false, mergeSha: null, reason: msg };
  }
  const data = ghJson<{ mergeCommit: { oid: string } | null }>(
    ["pr", "view", prUrl, "--json", "mergeCommit"],
    cwd,
  );
  return { merged: true, mergeSha: data?.mergeCommit?.oid ?? null };
}

export function getCheckConclusion(
  ownerRepo: string,
  ref: string,
  checkName: string,
): CheckConclusion {
  const data = ghJson<{ check_runs: CheckRun[] }>([
    "api",
    `repos/${ownerRepo}/commits/${ref}/check-runs?per_page=100`,
  ]);
  if (!data) return "missing";
  const match = data.check_runs.find((r) => r.name === checkName);
  if (!match) return "missing";
  if (match.status !== "completed") return "pending";
  return (match.conclusion ?? "neutral") as CheckConclusion;
}

export interface RollingPrInfo {
  number: number;
  url: string;
  body: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  mergedAt: string | null;
  mergeCommitOid: string | null;
}

export function findOpenPr(
  ownerRepo: string,
  head: string,
  base: string,
): RollingPrInfo | null {
  const list = ghJson<Array<{ number: number; url: string }>>([
    "pr",
    "list",
    "--repo",
    ownerRepo,
    "--state",
    "open",
    "--base",
    base,
    "--head",
    head,
    "--json",
    "number,url",
  ]);
  if (!list || list.length === 0) return null;
  const first = list[0]!;
  return getPrInfo(ownerRepo, first.number);
}

export function getPrInfo(
  ownerRepo: string,
  prNumber: number,
): RollingPrInfo | null {
  const data = ghJson<{
    number: number;
    url: string;
    body: string;
    state: "OPEN" | "MERGED" | "CLOSED";
    mergedAt: string | null;
    mergeCommit: { oid: string } | null;
  }>([
    "pr",
    "view",
    String(prNumber),
    "--repo",
    ownerRepo,
    "--json",
    "number,url,body,state,mergedAt,mergeCommit",
  ]);
  if (!data) return null;
  return {
    number: data.number,
    url: data.url,
    body: data.body ?? "",
    state: data.state,
    mergedAt: data.mergedAt,
    mergeCommitOid: data.mergeCommit?.oid ?? null,
  };
}

export function createPr(
  ownerRepo: string,
  head: string,
  base: string,
  title: string,
  body: string,
): RollingPrInfo | null {
  const url = ghText([
    "pr",
    "create",
    "--repo",
    ownerRepo,
    "--head",
    head,
    "--base",
    base,
    "--title",
    title,
    "--body",
    body,
  ]);
  if (!url) return null;
  const m = url.match(/\/pull\/(\d+)/);
  if (!m) return null;
  return getPrInfo(ownerRepo, Number(m[1]));
}

export function updatePrBody(
  ownerRepo: string,
  prNumber: number,
  body: string,
): boolean {
  try {
    execFileSync(
      "gh",
      [
        "pr",
        "edit",
        String(prNumber),
        "--repo",
        ownerRepo,
        "--body",
        body,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    return true;
  } catch {
    return false;
  }
}

// Extract `owner/repo` from a PR URL like https://github.com/foo/bar/pull/42.
export function ownerRepoFromPrUrl(prUrl: string): string | null {
  const m = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/);
  return m ? m[1]! : null;
}
