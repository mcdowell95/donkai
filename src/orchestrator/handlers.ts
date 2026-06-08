import { config } from "../config.js";
import {
  addComment,
  addLabel,
  type CommentSummary,
  type IssueSummary,
  removeLabel,
  transitionIssue,
} from "../linear/queries.js";
import { logEvent } from "../registry/db.js";
import {
  getSession,
  newState,
  upsertSession,
  type WorkerState,
  type WorkerStatus,
} from "../registry/sessions.js";
import { runWorker, type WorkerResult } from "../worker/runner.js";
import { buildResumePrompt, buildTicketPrompt } from "../worker/prompts.js";
import { extractBlocked, extractDoneSummary, extractPrUrls } from "../worker/parse.js";
import { setupWorkspace, teardownWorkspace } from "./workspace.js";
import { harvestLearnings } from "./harvest.js";
import {
  attemptMerge,
  evaluateGuards,
  recordMerge,
  shouldAttemptAutoMerge,
} from "./autonomy.js";
import { inferRepo } from "./queue.js";

export async function handleNewTicket(issue: IssueSummary): Promise<void> {
  const key = issue.identifier;
  console.log(`▶ New ticket: ${key} — ${issue.title}`);
  logEvent(key, "ticket_pickup", { title: issue.title });

  const workspace = setupWorkspace(key);
  const repo = inferRepo(issue);
  const state: WorkerState = {
    ...newState({
      ticket_key: key,
      issue_id: issue.id,
      summary: issue.title,
      repo,
      status: "running",
    }),
    workspace_dir: workspace,
  };
  upsertSession(state);

  await transitionIssue(issue.id, config.states.inProgress);
  await addComment(
    issue.id,
    `🤖 Donkai picked up this ticket. Working in \`${workspace}\`.`,
  );

  const prompt = buildTicketPrompt(issue);
  const result = await runWorker({ ticketKey: key, workspace, prompt });

  state.session_id = result.sessionId;
  await finaliseResult(state, issue, result);
}

export async function handleResumedTicket(issue: IssueSummary): Promise<void> {
  const key = issue.identifier;
  const state = getSession(key);
  if (!state || !state.session_id || !state.workspace_dir) {
    console.warn(`  No session for ${key}, treating as new ticket`);
    await handleNewTicket(issue);
    return;
  }
  console.log(`▶ Resuming: ${key} (session ${state.session_id.slice(0, 8)}...)`);

  await removeLabel(issue.id, "cc-suspended");
  await removeLabel(issue.id, "cc-awaiting-review");
  await transitionIssue(issue.id, config.states.inProgress);
  await addComment(issue.id, `🤖 Donkai resuming work on this ticket.`);

  state.status = "running";
  upsertSession(state);

  const prompt = buildResumePrompt(key, issue.comments);
  const result = await runWorker({
    ticketKey: key,
    workspace: state.workspace_dir,
    prompt,
    resumeSessionId: state.session_id,
  });

  state.session_id = result.sessionId;
  await finaliseResult(state, issue, result);
}

export async function handleLocalResume(
  state: WorkerState,
  issue: IssueSummary,
  responseText: string,
): Promise<void> {
  if (!state.workspace_dir) return;
  const key = state.ticket_key;
  console.log(`▶ Local resume: ${key} (dashboard response received)`);

  state.pending_question = null;
  state.status = "running";
  upsertSession(state);

  await removeLabel(issue.id, "cc-suspended");
  await transitionIssue(issue.id, config.states.inProgress);
  await addComment(issue.id, `🤖 Donkai resuming — response received via dashboard.`);

  const synthComment: CommentSummary = {
    author: "human",
    authorName: "Dashboard responder",
    body: responseText,
    createdAt: new Date().toISOString(),
  };
  const prompt = buildResumePrompt(key, [synthComment]);
  const result = await runWorker({
    ticketKey: key,
    workspace: state.workspace_dir,
    prompt,
    resumeSessionId: state.session_id ?? undefined,
  });

  state.session_id = result.sessionId;
  await finaliseResult(state, issue, result);
}

export async function handleRelease(state: WorkerState, issue: IssueSummary): Promise<void> {
  if (!state.workspace_dir) return;
  const key = state.ticket_key;
  console.log(`▶ Release: ${key} (human handing back control)`);

  const handoverPrompt = buildResumePrompt(
    key,
    issue.comments,
    "A human took over this session directly to redirect or unstick you. They have now released control back to Donkai. Assess the current state of files, branch, and PR before continuing.",
  );

  await addComment(issue.id, "🤖 Donkai resuming after human takeover.");
  state.status = "running";
  state.pending_question = null;
  upsertSession(state);

  const result = await runWorker({
    ticketKey: key,
    workspace: state.workspace_dir,
    prompt: handoverPrompt,
    resumeSessionId: state.session_id ?? undefined,
  });
  state.session_id = result.sessionId;
  await finaliseResult(state, issue, result);
}

async function finaliseResult(
  state: WorkerState,
  issue: IssueSummary,
  result: WorkerResult,
): Promise<void> {
  const key = state.ticket_key;
  state.status = mapOutcomeToStatus(result.outcome);

  if (result.outcome === "done") {
    state.pr_urls = extractPrUrls(result.output);
    if (state.session_id) {
      try {
        await harvestLearnings(key, state.session_id, state.workspace_dir!);
      } catch (err) {
        console.warn(`  harvest failed (non-fatal): ${err}`);
      }
    }
    await handleDoneOutcome(state, issue, result);
  } else if (result.outcome === "blocked_local") {
    await handleBlockedLocal(state, issue, result);
  } else if (result.outcome === "blocked_linear") {
    await handleBlockedLinear(state, issue, result);
  } else if (result.outcome === "detached") {
    console.log(`  ✋ ${key} detached for human takeover`);
  } else {
    await handleError(state, issue, result);
  }

  upsertSession(state);
}

async function handleDoneOutcome(
  state: WorkerState,
  issue: IssueSummary,
  result: WorkerResult,
): Promise<void> {
  const key = state.ticket_key;
  const summary = extractDoneSummary(result.output);

  if (shouldAttemptAutoMerge()) {
    const guards = evaluateGuards({
      ticketKey: key,
      output: result.output,
      workspace: state.workspace_dir!,
      repo: state.repo,
      ticketLabels: issue.labels,
    });

    if (guards.ok) {
      const merge = attemptMerge({
        ticketKey: key,
        output: result.output,
        workspace: state.workspace_dir!,
        repo: state.repo,
        ticketLabels: issue.labels,
      });
      if (merge.merged) {
        recordMerge(key, merge.prUrl, guards);
        await addLabel(issue.id, "merged-by-claude");
        await addComment(
          issue.id,
          `🤖 Auto-merged by Donkai.\n\n**Summary:** ${summary}\n**PR:** ${merge.prUrl}\n**Guards passed:** ${guards.passed.join(", ")}\n**Diffstat:** ${guards.filesChanged ?? "?"} files / ${guards.linesChanged ?? "?"} lines`,
        );
        await transitionIssue(issue.id, config.states.done);
        teardownWorkspace(state.workspace_dir);
        state.status = "merged";
        return;
      }
      await addComment(
        issue.id,
        `🤖 Donkai tried to auto-merge but \`gh pr merge\` failed: ${merge.reason}\n\nFalling back to review_only — please merge manually.`,
      );
    } else {
      await addComment(
        issue.id,
        `🤖 Donkai completed work. Auto-merge skipped because:\n${guards.reasons.map((r) => `- ${r}`).join("\n")}\n\nPR ready for human review.`,
      );
    }
  }

  console.log(`  👀 ${key} ready for review`);
  await addComment(
    issue.id,
    `🤖 Claude Code completed work — ready for review.\n\n${summary}\n\nIf changes are needed, comment and move back to "${config.states.ready}". If approved, move to "${config.states.done}".`,
  );
  await addLabel(issue.id, "cc-awaiting-review");
  await transitionIssue(issue.id, config.states.review);
  state.status = "awaiting_review";
}

async function handleBlockedLocal(
  state: WorkerState,
  issue: IssueSummary,
  result: WorkerResult,
): Promise<void> {
  const key = state.ticket_key;
  const reason = extractBlocked(result.output);
  console.log(`  ⏸ ${key} blocked (dashboard): ${reason}`);
  state.pending_question = reason;
  state.status = "suspended_local";
  await addLabel(issue.id, "cc-suspended");
  await transitionIssue(issue.id, config.states.waiting);
  await addComment(
    issue.id,
    `🤖 Waiting for input via the Donkai dashboard:\n\n${reason}`,
  );
}

async function handleBlockedLinear(
  state: WorkerState,
  issue: IssueSummary,
  result: WorkerResult,
): Promise<void> {
  const key = state.ticket_key;
  const reason = extractBlocked(result.output);
  console.log(`  ⏸ ${key} blocked (Linear action needed): ${reason}`);
  await addComment(
    issue.id,
    `🤖 **Human action required:**\n\n${reason}\n\nWhen done, comment with the result and move the ticket back to "${config.states.ready}".`,
  );
  await addLabel(issue.id, "cc-suspended");
  await transitionIssue(issue.id, config.states.waiting);
}

async function handleError(
  state: WorkerState,
  issue: IssueSummary,
  result: WorkerResult,
): Promise<void> {
  const key = state.ticket_key;
  console.error(`  ❌ ${key} errored`);
  await addComment(
    issue.id,
    `🤖 Claude Code encountered an error — human review needed:\n\n${result.output.slice(-500)}\n\nFix the issue and move back to "${config.states.ready}", or close as "${config.states.done}".`,
  );
  await transitionIssue(issue.id, config.states.waiting);
  state.status = "error";
}

function mapOutcomeToStatus(outcome: WorkerResult["outcome"]): WorkerStatus {
  switch (outcome) {
    case "done":
      return "awaiting_review";
    case "blocked_local":
      return "suspended_local";
    case "blocked_linear":
      return "suspended_linear";
    case "detached":
      return "detached";
    case "error":
      return "error";
  }
}
