import { config } from "../config.js";
import { findReadyIssues, findResumedIssues, getIssue, type IssueSummary } from "../linear/queries.js";
import { db, logEvent } from "../registry/db.js";
import {
  getSession,
  listSessions,
  newState,
  upsertSession,
} from "../registry/sessions.js";
import { consumeSignal, hasAnyPendingSignal, listSignals } from "../ipc/signals.js";
import { teardownWorkspace } from "./workspace.js";
import {
  handleLocalResume,
  handleNewTicket,
  handleRelease,
  handleResumedTicket,
} from "./handlers.js";
import {
  alreadyQueuedOrRunning,
  dequeue,
  enqueue,
  inferRepo,
  pickNextRunnable,
} from "./queue.js";
import {
  pollDevDeploys,
  pollProdPromotions,
  pollRollingMainPrs,
} from "./staging.js";
import { onWake } from "../control/actions.js";
import { isPaused, recordTick } from "../control/settings.js";
import { matchesRules } from "../control/rules.js";

const inflight = new Set<string>();

export async function startOrchestrator(): Promise<void> {
  console.log("─".repeat(60));
  console.log(`Donkai orchestrator starting`);
  console.log(`Teams: ${config.linear.teamKeys.join(", ")}`);
  console.log(`Concurrency: ${config.concurrency.mode} (max ${config.concurrency.maxConcurrent})`);
  console.log(`Autonomy: ${config.autonomy.level}`);
  console.log(
    `Workflow: ${config.workflow.mode} (dev=${config.workflow.devBranch}, main=${config.workflow.mainBranch}` +
      (config.workflow.mode === "staging_promote"
        ? `, dev-check=${config.workflow.devDeployCheck}, main-check=${config.workflow.mainDeployCheck}`
        : "") +
      `)`,
  );
  if (config.workflow.mode === "staging_promote") {
    const coolifyConfigured =
      config.coolify.baseUrl && config.coolify.apiToken;
    console.log(
      `Coolify: ${coolifyConfigured ? config.coolify.baseUrl : "NOT CONFIGURED"} (timeout ${config.coolify.deployTimeoutSecs}s)`,
    );
  }
  console.log(`Workspace root: ${config.workspaceRoot}`);
  console.log(`Poll interval: ${config.pollIntervalMs / 1000}s`);
  console.log(`Dashboard: http://${config.dashboard.host}:${config.dashboard.port}`);
  console.log("─".repeat(60));

  logEvent(null, "orchestrator_start", { config: redactedConfig() });

  let stop = false;
  process.on("SIGINT", () => {
    console.log("\nShutting down orchestrator...");
    stop = true;
  });

  while (!stop) {
    try {
      await tick();
    } catch (err) {
      console.error("Orchestrator tick error:", err);
      logEvent(null, "orchestrator_error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await sleepUntilSignalOrInterval();
  }
}

async function tick(): Promise<void> {
  recordTick();
  await drainTakeoverSignals();
  await drainReleaseSignals();
  await drainResponseSignals();
  await checkHumanWaitTickets();
  if (config.workflow.mode === "staging_promote") {
    await pollDevDeploys();
    await pollRollingMainPrs();
    await pollProdPromotions();
  }
  // Pause gates new pickups and worker starts only. In-flight workers,
  // staging polls, and blocked-answer handling above keep running so
  // half-finished pipelines aren't stranded.
  if (isPaused()) return;
  await pollReady();
  await pollResumed();
  scheduleFromQueue();
}

async function drainTakeoverSignals(): Promise<void> {
  for (const { ticketKey } of listSignals("takeover")) {
    const state = getSession(ticketKey);
    if (!state) {
      consumeSignal(ticketKey, "takeover");
      continue;
    }
    if (state.status === "running") {
      // The in-process watcher inside runWorker will pick this up.
      continue;
    }
    console.log(`  ✋ ${ticketKey} detached for human takeover (was ${state.status})`);
    state.status = "detached";
    state.pending_question = null;
    upsertSession(state);
    consumeSignal(ticketKey, "takeover");
  }
}

async function drainReleaseSignals(): Promise<void> {
  for (const { ticketKey } of listSignals("release")) {
    const state = getSession(ticketKey);
    if (!state) {
      consumeSignal(ticketKey, "release");
      continue;
    }
    if (state.status !== "detached") {
      consumeSignal(ticketKey, "release");
      continue;
    }
    consumeSignal(ticketKey, "release");
    const issue = await getIssue(state.issue_id);
    await runWithGuard(ticketKey, () => handleRelease(state, issue));
  }
}

async function drainResponseSignals(): Promise<void> {
  for (const { ticketKey, payload } of listSignals("response")) {
    const state = getSession(ticketKey);
    if (!state || state.status !== "suspended_local") {
      consumeSignal(ticketKey, "response");
      continue;
    }
    consumeSignal(ticketKey, "response");
    const issue = await getIssue(state.issue_id);
    await runWithGuard(ticketKey, () => handleLocalResume(state, issue, payload));
  }
}

async function checkHumanWaitTickets(): Promise<void> {
  const watchStatuses = new Set([
    "awaiting_review",
    "suspended_linear",
    "suspended_local",
    "detached",
    "error",
  ]);
  for (const state of listSessions()) {
    if (!watchStatuses.has(state.status)) continue;
    try {
      const issue = await getIssue(state.issue_id);
      if (issue.stateName.toLowerCase() === config.states.done.toLowerCase()) {
        console.log(`  ✅ ${state.ticket_key} closed in Linear, marking done`);
        teardownWorkspace(state.workspace_dir);
        state.status = "done";
        state.pending_question = null;
        upsertSession(state);
      } else if (
        issue.stateName.toLowerCase() === config.states.ready.toLowerCase() &&
        state.status !== "suspended_local"
      ) {
        console.log(`  🔁 ${state.ticket_key} sent back for changes`);
        await runWithGuard(state.ticket_key, () => handleResumedTicket(issue));
      }
    } catch (err) {
      console.warn(`  could not refresh ${state.ticket_key}:`, err);
    }
  }
}

const loggedFiltered = new Set<string>();

async function pollReady(): Promise<void> {
  const issues = await findReadyIssues();
  for (const issue of issues) {
    if (alreadyQueuedOrRunning(issue.identifier)) continue;
    if (!matchesRules(issue)) {
      if (!loggedFiltered.has(issue.identifier)) {
        loggedFiltered.add(issue.identifier);
        console.log(`  ⛔ ${issue.identifier} skipped by pickup rules`);
        logEvent(issue.identifier, "pickup_filtered");
      }
      continue;
    }
    loggedFiltered.delete(issue.identifier);
    const repo = inferRepo(issue);
    upsertSession({
      ...newState({
        ticket_key: issue.identifier,
        issue_id: issue.id,
        summary: issue.title,
        repo,
        status: "queued",
      }),
    });
    enqueue(issue, repo);
  }
}

async function pollResumed(): Promise<void> {
  const resumed = await findResumedIssues();
  for (const issue of resumed) {
    const state = getSession(issue.identifier);
    if (!state) continue;
    if (state.status === "detached") continue;
    if (state.status === "suspended_linear") {
      await runWithGuard(issue.identifier, () => handleResumedTicket(issue));
    }
  }
}

function scheduleFromQueue(): void {
  const picks = pickNextRunnable();
  for (const row of picks) {
    if (inflight.has(row.ticket_key)) continue;
    void runWithGuard(row.ticket_key, async () => {
      dequeue(row.ticket_key);
      const issue: IssueSummary = await getIssue(row.issue_id);
      await handleNewTicket(issue);
    });
  }
}

async function runWithGuard(ticketKey: string, fn: () => Promise<void>): Promise<void> {
  if (inflight.has(ticketKey)) return;
  inflight.add(ticketKey);
  try {
    await fn();
  } catch (err) {
    console.error(`  handler error for ${ticketKey}:`, err);
    logEvent(ticketKey, "handler_error", {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    inflight.delete(ticketKey);
  }
}

async function sleepUntilSignalOrInterval(): Promise<void> {
  const start = Date.now();
  let woken = false;
  const off = onWake((reason) => {
    console.log(`  wake: ${reason}`);
    woken = true;
  });
  try {
    while (!woken && Date.now() - start < config.pollIntervalMs) {
      await new Promise((r) => setTimeout(r, 500));
      if (hasAnyPendingSignal()) {
        console.log("  IPC signal detected, waking up early");
        return;
      }
    }
  } finally {
    off();
  }
}

function redactedConfig(): unknown {
  return {
    teams: config.linear.teamKeys,
    states: config.states,
    concurrency: config.concurrency,
    autonomy: { ...config.autonomy, repoAllowlist: config.autonomy.repoAllowlist },
    workflow: config.workflow,
  };
}

// db() import keeps the SQLite handle open across the loop
void db;
