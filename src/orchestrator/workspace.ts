import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";

const SETTINGS = {
  enableAllProjectMcpServers: true,
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

export function setupWorkspace(ticketKey: string): string {
  const slug = ticketKey.replace(/-/g, "_").toLowerCase();
  const workspace = join(config.workspaceRoot, slug);
  mkdirSync(workspace, { recursive: true });

  if (existsSync(config.workerClaudeMd)) {
    copyFileSync(config.workerClaudeMd, join(workspace, "CLAUDE.md"));
  }

  if (existsSync(config.workerMcpJson)) {
    copyFileSync(config.workerMcpJson, join(workspace, ".mcp.json"));
  }

  const claudeDir = join(workspace, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, "settings.local.json"), JSON.stringify(SETTINGS, null, 2));

  return workspace;
}

export function teardownWorkspace(workspaceDir: string | null): void {
  if (!workspaceDir) return;
  if (!existsSync(workspaceDir)) return;
  rmSync(workspaceDir, { recursive: true, force: true });
}
