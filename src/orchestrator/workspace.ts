import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import type { IssueSummary } from "../linear/queries.js";

const SETTINGS = {
  enableAllProjectMcpServers: false,
  permissions: {
    allow: [
      "Read",
      "Write",
      "Edit",
      "mcp__*",
      "Bash(git *)",
      "Bash(gh pr create*)",
      "Bash(gh pr view*)",
      "Bash(gh pr list*)",
      "Bash(gh pr checks*)",
      "Bash(gh pr diff*)",
      "Bash(gh pr status*)",
      "Bash(gh pr ready*)",
      "Bash(gh run list*)",
      "Bash(gh run view*)",
      "Bash(gh run watch*)",
      "Bash(gh workflow view*)",
      "Bash(gh workflow list*)",
      "Bash(gh repo view*)",
      "Bash(gh auth status)",
      "Bash(python *)",
      "Bash(python3 *)",
      "Bash(node *)",
      "Bash(npm *)",
      "Bash(pnpm *)",
      "Bash(yarn *)",
      "Bash(pip install*)",
      "Bash(pip3 install*)",
      "Bash(pip list*)",
      "Bash(pip3 list*)",
      "Bash(pip show*)",
      "Bash(pip3 show*)",
      "Bash(ls*)",
      "Bash(cat *)",
      "Bash(mkdir *)",
      "Bash(cp *)",
      "Bash(mv *)",
      "Bash(rm *)",
      "Bash(find *)",
      "Bash(grep *)",
      "Bash(head *)",
      "Bash(tail *)",
      "Bash(wc *)",
      "Bash(which *)",
      "Bash(pwd)",
      "Bash(echo *)",
      "Bash(export *)",
      "Bash(source *)",
    ],
    deny: [
      "Bash(sudo *)",
      "Bash(su *)",
      "Bash(doas *)",
      "Bash(rm -rf /)",
      "Bash(rm -rf /*)",
      "Bash(rm -rf ~)",
      "Bash(rm -rf ~/*)",
      "Bash(rm -rf $HOME*)",
      "Bash(rm -rf ..*)",
      "Bash(rm -rf .. *)",
      "Bash(rm -rf .*)",
      "Bash(rm -fr *)",
      "Bash(rm --recursive --force /*)",
      "Bash(find * -delete*)",
      "Bash(find * -exec rm*)",
      "Bash(git push --force*)",
      "Bash(git push -f *)",
      "Bash(git push --force-with-lease*)",
      "Bash(git push --delete*)",
      "Bash(git push * --force*)",
      "Bash(git push * -f *)",
      "Bash(git reset --hard*)",
      "Bash(git clean -f*)",
      "Bash(git clean -d*)",
      "Bash(git clean -x*)",
      "Bash(git branch -D *)",
      "Bash(git branch --delete --force*)",
      "Bash(git filter-branch*)",
      "Bash(git update-ref -d*)",
      "Bash(git reflog expire*)",
      "Bash(git gc --prune*)",
      "Bash(pip uninstall*)",
      "Bash(pip3 uninstall*)",
      "Bash(curl * | sh*)",
      "Bash(curl * | bash*)",
      "Bash(wget * | sh*)",
      "Bash(wget * | bash*)",
      "Bash(chmod 777*)",
      "Bash(chmod -R 777*)",
      "Bash(chown -R*)",
    ],
  },
};

export function setupWorkspace(ticketKey: string, issue?: IssueSummary): string {
  const slug = ticketKey.replace(/-/g, "_").toLowerCase();
  const workspace = join(config.workspaceRoot, slug);
  mkdirSync(workspace, { recursive: true });

  // Prefer the caveman-compressed context file when configured — it is
  // injected into every worker turn, so size matters.
  const claudeMdSource =
    config.workerClaudeMdCompressed && existsSync(config.workerClaudeMdCompressed)
      ? config.workerClaudeMdCompressed
      : config.workerClaudeMd;
  if (existsSync(claudeMdSource)) {
    copyFileSync(claudeMdSource, join(workspace, "CLAUDE.md"));
  }

  const enabledServers = writeFilteredMcpJson(workspace, issue);

  const claudeDir = join(workspace, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    join(claudeDir, "settings.local.json"),
    JSON.stringify({ ...SETTINGS, enabledMcpjsonServers: enabledServers }, null, 2),
  );

  return workspace;
}

// Every MCP server a worker loads costs system-prompt tokens for its full tool
// schemas on every turn. Only ship the servers this ticket plausibly needs:
// the MCP_ALWAYS_SERVERS set, plus any server whose name is mentioned in the
// ticket (title/description/labels/attachment URLs) — which covers the Sentry
// attachment case (sentry.io URL mentions "sentry").
function writeFilteredMcpJson(workspace: string, issue?: IssueSummary): string[] {
  if (!existsSync(config.workerMcpJson)) return [];
  let parsed: { mcpServers?: Record<string, unknown> };
  try {
    parsed = JSON.parse(readFileSync(config.workerMcpJson, "utf-8"));
  } catch {
    copyFileSync(config.workerMcpJson, join(workspace, ".mcp.json"));
    return [];
  }
  const all = parsed.mcpServers ?? {};
  const always = new Set(config.mcpAlwaysServers.map((s) => s.toLowerCase()));

  const haystack = issue
    ? [
        issue.title,
        issue.description,
        ...issue.labels,
        ...issue.attachments.map((a) => `${a.title} ${a.url}`),
      ]
        .join(" ")
        .toLowerCase()
    : "";

  const selected: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(all)) {
    const lower = name.toLowerCase();
    // No issue context (shouldn't happen on the new-ticket path): ship all.
    if (!issue || always.has(lower) || haystack.includes(lower)) {
      selected[name] = server;
    }
  }

  writeFileSync(
    join(workspace, ".mcp.json"),
    JSON.stringify({ ...parsed, mcpServers: selected }, null, 2),
  );
  return Object.keys(selected);
}

export function teardownWorkspace(workspaceDir: string | null): void {
  if (!workspaceDir) return;
  if (!existsSync(workspaceDir)) return;
  rmSync(workspaceDir, { recursive: true, force: true });
}
