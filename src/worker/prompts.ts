import { config } from "../config.js";
import type { AttachmentSummary, CommentSummary, IssueSummary } from "../linear/queries.js";

const priorityNames: Record<number, string> = {
  0: "No priority",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

export function autonomyInstructionBlock(): string {
  if (config.workflow.mode === "staging_promote") {
    return [
      "## Autonomy: staging_promote",
      `Open a PR targeting \`${config.workflow.devBranch}\` (NOT \`${config.workflow.mainBranch}\`).`,
      `After CI is green, output DONE: with the PR URL. Donkai will squash-merge into \`${config.workflow.devBranch}\`,`,
      `wait for the \`${config.workflow.devDeployCheck}\` deploy check, then append your ticket to the rolling`,
      `\`${config.workflow.devBranch} → ${config.workflow.mainBranch}\` PR. A human handles the promotion to \`${config.workflow.mainBranch}\`.`,
      `**Do not open PRs against \`${config.workflow.mainBranch}\` and do not merge anything yourself.**`,
      "",
      "When you output DONE, ALSO emit two labeled blocks so the rolling promotion PR",
      "can show testing steps and customer-facing release notes:",
      "",
      "```",
      "DONE: <one-line summary> <PR URL>",
      "",
      "TESTING:",
      "- Concrete, click-by-click steps a teammate can follow on dev to verify the change.",
      "- Cover the happy path and at least one edge case.",
      "- Mention any setup (URLs, fixtures, accounts) needed.",
      "",
      "RELEASE_NOTES:",
      "- One short, customer-facing bullet describing what's new or fixed.",
      "- Write it in plain language — no ticket keys, no internal jargon.",
      "- Skip the block entirely (omit the RELEASE_NOTES section) if the change is internal-only (refactor, infra, chore).",
      "```",
    ].join("\n");
  }

  const a = config.autonomy;
  switch (a.level) {
    case "review_only":
      return [
        "## Autonomy: review_only",
        "After CI is green, output DONE and STOP. A human will merge the PR.",
      ].join("\n");
    case "auto_merge_on_green":
      return [
        "## Autonomy: auto_merge_on_green",
        "After CI is green, do NOT merge yourself.",
        "Output DONE: with the PR url and a one-line diff summary",
        `(${a.maxFilesChanged} files / ${a.maxLinesChanged} lines max).`,
        "The orchestrator evaluates guards and merges if eligible.",
      ].join("\n");
    case "full_yolo":
      return [
        "## Autonomy: full_yolo",
        `If a CI run fails you may retry up to ${a.ciRetries} times before BLOCKED.`,
        "After CI is green output DONE; orchestrator merges.",
      ].join("\n");
  }
}

export function buildTicketPrompt(issue: IssueSummary): string {
  const labels = issue.labels.length ? issue.labels.join(", ") : "none";
  const desc = issue.description.trim() || "No description provided.";
  const commentsBlock = renderComments(issue.comments);
  const attachmentsBlock = renderAttachments(issue.attachments);
  const autonomy = autonomyInstructionBlock();
  const ident = issue.identifier;
  const baseBranch =
    config.workflow.mode === "staging_promote"
      ? config.workflow.devBranch
      : config.workflow.mainBranch;

  return `You are working on Linear ticket ${ident} (${issue.url}).

## Ticket details
- **Title**: ${issue.title}
- **Priority**: ${priorityNames[issue.priority] ?? "Medium"}
- **Labels**: ${labels}
- **Project**: ${issue.project ?? "(none)"}

## Description
${desc}
${commentsBlock}${attachmentsBlock}
${autonomy}

## Instructions
1. Tell me your session ID first so I can record it for resume.
2. Read \`CLAUDE.md\` in this directory for repo context and conventions.
3. Determine which repos you need. Clone them into this workspace.
4. Create a feature branch \`feat/${ident.toLowerCase()}-<short-desc>\` from a fresh \`${baseBranch}\` (\`git fetch origin && git checkout ${baseBranch} && git pull --ff-only && git checkout -b feat/...\`).
5. Implement the work. Commit with clear messages referencing ${ident}.
6. Open a PR with \`gh pr create --base ${baseBranch}\`.
7. Run \`gh pr checks <pr-number> --watch --fail-fast\` after every push. Loop on failure, fix, push, re-check.
8. You may not output DONE until \`gh pr checks\` exits 0. After three consecutive failed runs (or an unfixable failure), output BLOCKED.
9. If you cannot proceed without human input, output a single line starting with \`BLOCKED:\` followed by what you need.

## Output protocol
- \`DONE: <one-line summary>\` — work complete, CI green, PR open. Include the PR URL.
- \`BLOCKED: <reason>\` — needs human input. Always commit + push current progress before BLOCKED.
`;
}

export function buildResumePrompt(
  ticketKey: string,
  comments: CommentSummary[],
  handoverReason?: string,
): string {
  const thread = comments
    .map((c) => `[${c.author === "bot" ? "You (bot)" : c.authorName}]: ${c.body}`)
    .join("\n\n");

  const lastHuman = [...comments].reverse().find((c) => c.author === "human");
  const action = lastHuman
    ? `The most recent human message is:\n"${lastHuman.body}"\n\nAct on this now.`
    : "Continue where you left off.";

  const handover = handoverReason
    ? `\n\n## Handover context\n${handoverReason}\n`
    : "";

  return `You are resuming work on Linear ticket ${ticketKey}.

Recent comment thread (oldest first):

${thread || "(no recent comments)"}
${handover}
---
${action}

If you still need something from the human, state it clearly with a single \`BLOCKED:\` line.
When complete, output \`DONE: <summary>\` including the PR URL.
`;
}

export function buildHarvestPrompt(ticketKey: string, workerClaudeMdPath: string): string {
  return `You just completed ticket ${ticketKey}. Quick knowledge harvest before we wrap up.

Read ${workerClaudeMdPath} — the shared context file every Donkai worker receives.

Think about what you learned this session about our repos, systems, architecture, or non-obvious gotchas. Bar for adding: would a future worker be meaningfully better off knowing this? Skip ticket status, project state, or anything already in the file or derivable from code/docs.

If nothing is worth adding, output: DONE: no learnings to add

Otherwise, write ONE tight paragraph or small bullet list (no brain dumping) describing what should be added and to which section. Format your output exactly as:

PROPOSAL:
<your proposed text>
SECTION: <section name in worker-CLAUDE.md, or "new section: X">

Then output: DONE: proposed learning for review

Do NOT edit the file yourself. Do NOT commit. A human will review the proposal in the Donkai dashboard before it's merged in.
`;
}

function renderComments(comments: CommentSummary[]): string {
  if (comments.length === 0) return "";
  const lines = comments.map(
    (c) =>
      `- [${c.author === "bot" ? "Bot" : c.authorName}]: ${c.body.replace(/\n/g, " ").slice(0, 400)}`,
  );
  return `\n## Recent comments\n${lines.join("\n")}\n`;
}

function renderAttachments(attachments: AttachmentSummary[]): string {
  if (attachments.length === 0) return "";
  const lines = attachments.map((a) => {
    const title = a.title.replace(/\n/g, " ").slice(0, 200);
    const sub = a.subtitle ? ` — ${a.subtitle.replace(/\n/g, " ").slice(0, 200)}` : "";
    return `- [${title}](${a.url})${sub}`;
  });
  const hasSentry = attachments.some((a) => /sentry\.io/.test(a.url));
  const sentryHint = hasSentry
    ? "\n\nA Sentry issue is linked above. Use the Sentry MCP tools (e.g. `get_sentry_resource` with the URL) to pull the stacktrace, tags, and trace context before starting work."
    : "";
  return `\n## Attachments\n${lines.join("\n")}${sentryHint}\n`;
}
