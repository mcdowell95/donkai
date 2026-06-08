import { execFileSync } from "node:child_process";
import { config } from "../config.js";
import { db, logEvent } from "../registry/db.js";
import { extractPrUrls } from "../worker/parse.js";

export interface MergeGuardResult {
  ok: boolean;
  reasons: string[];
  passed: string[];
  filesChanged?: number;
  linesChanged?: number;
}

export interface MergeContext {
  ticketKey: string;
  output: string;
  workspace: string;
  repo: string | null;
  ticketLabels: string[];
}

export function shouldAttemptAutoMerge(): boolean {
  return config.autonomy.level !== "review_only";
}

export function evaluateGuards(ctx: MergeContext): MergeGuardResult {
  const reasons: string[] = [];
  const passed: string[] = [];
  const a = config.autonomy;

  if (a.repoAllowlist.length === 0) {
    reasons.push("AUTO_MERGE_REPOS_ALLOWLIST is empty — no repo eligible");
    return { ok: false, reasons, passed };
  }
  if (!ctx.repo || !a.repoAllowlist.includes(ctx.repo)) {
    reasons.push(`repo "${ctx.repo ?? "(unknown)"}" not in AUTO_MERGE_REPOS_ALLOWLIST`);
    return { ok: false, reasons, passed };
  }
  passed.push("repo_allowlisted");

  if (a.requireLabel && !ctx.ticketLabels.includes(a.requireLabel)) {
    reasons.push(`ticket missing required label "${a.requireLabel}"`);
    return { ok: false, reasons, passed };
  }
  passed.push("label_present");

  const prUrls = extractPrUrls(ctx.output);
  if (prUrls.length === 0) {
    reasons.push("no PR URL detected in worker output");
    return { ok: false, reasons, passed };
  }
  const prUrl = prUrls[0]!;
  passed.push("pr_url_present");

  const diffStat = readPrDiffstat(prUrl);
  if (!diffStat) {
    reasons.push("could not read PR diffstat via gh");
    return { ok: false, reasons, passed };
  }

  if (diffStat.filesChanged > a.maxFilesChanged) {
    reasons.push(
      `${diffStat.filesChanged} files changed > AUTO_MERGE_MAX_FILES_CHANGED (${a.maxFilesChanged})`,
    );
  }
  if (diffStat.linesChanged > a.maxLinesChanged) {
    reasons.push(
      `${diffStat.linesChanged} lines changed > AUTO_MERGE_MAX_LINES_CHANGED (${a.maxLinesChanged})`,
    );
  }
  if (reasons.length === 0) passed.push("size_within_budget");

  const blockedPath = diffStat.files.find((f) =>
    a.blockPaths.some((p) => matchesGlob(f, p)),
  );
  if (blockedPath) {
    reasons.push(`changed path "${blockedPath}" matches AUTO_MERGE_BLOCK_PATHS`);
  } else {
    passed.push("paths_clean");
  }

  const lowerOut = ctx.output.toLowerCase();
  const blockedKeyword = a.blockKeywords.find((kw) => lowerOut.includes(kw));
  if (blockedKeyword) {
    reasons.push(`worker output contains blocked keyword "${blockedKeyword}"`);
  } else {
    passed.push("keywords_clean");
  }

  return {
    ok: reasons.length === 0,
    reasons,
    passed,
    filesChanged: diffStat.filesChanged,
    linesChanged: diffStat.linesChanged,
  };
}

export interface MergeOutcome {
  merged: boolean;
  prUrl: string;
  reason?: string;
}

export function attemptMerge(ctx: MergeContext): MergeOutcome {
  const prUrl = extractPrUrls(ctx.output)[0]!;
  try {
    execFileSync("gh", ["pr", "merge", prUrl, "--squash", "--delete-branch", "--admin"], {
      cwd: ctx.workspace,
      stdio: "inherit",
    });
    logEvent(ctx.ticketKey, "auto_merge", { prUrl });
    return { merged: true, prUrl };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logEvent(ctx.ticketKey, "auto_merge_failed", { prUrl, error: msg });
    return { merged: false, prUrl, reason: msg };
  }
}

export function recordMerge(
  ticketKey: string,
  prUrl: string,
  guards: MergeGuardResult,
): void {
  db()
    .prepare(
      `INSERT INTO merges (ticket_key, pr_url, merged_at, files_changed, lines_changed, guards_passed)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ticketKey,
      prUrl,
      new Date().toISOString(),
      guards.filesChanged ?? null,
      guards.linesChanged ?? null,
      JSON.stringify(guards.passed),
    );
}

interface DiffStat {
  filesChanged: number;
  linesChanged: number;
  files: string[];
}

function readPrDiffstat(prUrl: string): DiffStat | null {
  try {
    const out = execFileSync(
      "gh",
      ["pr", "view", prUrl, "--json", "files"],
      { encoding: "utf-8" },
    );
    const data = JSON.parse(out) as { files: { path: string; additions: number; deletions: number }[] };
    const files = data.files.map((f) => f.path);
    const linesChanged = data.files.reduce((s, f) => s + (f.additions ?? 0) + (f.deletions ?? 0), 0);
    return { filesChanged: files.length, linesChanged, files };
  } catch {
    return null;
  }
}

function matchesGlob(path: string, pattern: string): boolean {
  // Cheap glob: ** → .*, * → [^/]*, escape regex specials
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const re = "^" + esc.replace(/\*\*/g, "::DSTAR::").replace(/\*/g, "[^/]*").replace(/::DSTAR::/g, ".*") + "$";
  return new RegExp(re).test(path);
}
