import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { logEvent } from "../registry/db.js";

// Bare-mirror cache so workers clone from local disk instead of the network.
// Layout: <workspaceRoot>/mirrors/<repo>.git
// Requires GIT_REMOTE_BASE (e.g. https://github.com/myorg) to resolve remotes.

const MIRROR_REFRESH_MS = 5 * 60 * 1000;

const refreshing = new Map<string, Promise<void>>();
const lastRefresh = new Map<string, number>();

export function mirrorsEnabled(): boolean {
  return !!config.gitRemoteBase;
}

function mirrorPath(repo: string): string {
  return join(config.workspaceRoot, "mirrors", `${repo}.git`);
}

export function remoteUrl(repo: string): string {
  return `${config.gitRemoteBase}/${repo}.git`;
}

function git(args: string[], cwd?: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe", timeout: 10 * 60 * 1000 });
}

export async function ensureMirror(repo: string): Promise<void> {
  const inflight = refreshing.get(repo);
  if (inflight) return inflight;

  const work = (async () => {
    const path = mirrorPath(repo);
    if (!existsSync(path)) {
      mkdirSync(join(config.workspaceRoot, "mirrors"), { recursive: true });
      console.log(`  ⬇ creating mirror for ${repo}`);
      git(["clone", "--mirror", remoteUrl(repo), path]);
      logEvent(null, "mirror_created", { repo });
    } else if (Date.now() - (lastRefresh.get(repo) ?? 0) > MIRROR_REFRESH_MS) {
      git(["remote", "update", "--prune"], path);
    }
    lastRefresh.set(repo, Date.now());
  })();

  refreshing.set(repo, work);
  try {
    await work;
  } finally {
    refreshing.delete(repo);
  }
}

// Plain local clone from the mirror (fast disk-to-disk object transfer), then
// repoint origin at the real remote so pushes and later fetches hit GitHub.
// Deliberately not --reference: a pruned mirror must never corrupt a live
// workspace.
export function cloneFromMirror(repo: string, workspaceDir: string): string {
  const dest = join(workspaceDir, repo);
  if (existsSync(dest)) return dest;
  git(["clone", mirrorPath(repo), dest]);
  git(["remote", "set-url", "origin", remoteUrl(repo)], dest);
  git(["fetch", "origin", "--prune"], dest);
  return dest;
}

// Best-effort pre-clone for a ticket; returns the repo dir when it worked so
// the prompt can say "already cloned" instead of instructing a network clone.
export async function precloneForTicket(
  repo: string | null,
  workspaceDir: string,
): Promise<string | null> {
  if (!repo || !mirrorsEnabled()) return null;
  try {
    await ensureMirror(repo);
    return cloneFromMirror(repo, workspaceDir);
  } catch (err) {
    console.warn(`  mirror preclone failed for ${repo} (worker will clone itself):`, err);
    logEvent(null, "mirror_preclone_failed", {
      repo,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
