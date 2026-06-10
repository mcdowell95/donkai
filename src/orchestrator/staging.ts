import { config } from "../config.js";
import {
  addComment,
  getIssue,
  transitionIssue,
  type IssueSummary,
} from "../linear/queries.js";
import { db, logEvent } from "../registry/db.js";
import {
  getSession,
  upsertSession,
  type WorkerState,
} from "../registry/sessions.js";
import { teardownWorkspace } from "./workspace.js";
import {
  appUuidForRepo,
  getDeploymentStatus,
  isTerminal,
  triggerRedeploy,
  type CoolifyDeploymentStatus,
} from "./coolify.js";
import {
  createPr,
  findOpenPr,
  getCheckConclusion,
  getPrInfo,
  mergeFeaturePr,
  ownerRepoFromPrUrl,
  updatePrBody,
  type RollingPrInfo,
} from "./gh.js";

type DevStage = "awaiting_check" | "awaiting_redeploy";
type ProdStage = "awaiting_main_check" | "awaiting_prod_redeploy";

interface DevDeployWaitRow {
  ticket_key: string;
  issue_id: string;
  repo: string;
  feature_pr_url: string;
  merge_sha: string | null;
  check_name: string;
  ticket_summary: string | null;
  stage: DevStage;
  coolify_deployment_uuid: string | null;
  stage_entered_at: string | null;
  created_at: string;
}

interface RollingPrRow {
  repo: string;
  pr_number: number;
  pr_url: string;
  ticket_keys: string;
  created_at: string;
  updated_at: string;
}

interface ProdPromotionRow {
  repo: string;
  pr_url: string;
  merge_sha: string;
  ticket_keys: string;
  check_name: string;
  stage: ProdStage;
  coolify_deployment_uuid: string | null;
  stage_entered_at: string | null;
  created_at: string;
}

// ----------------------------------------------------------------------------
// Entry from handlers: feature DONE in staging_promote
// ----------------------------------------------------------------------------

export async function startDevDeployWait(args: {
  state: WorkerState;
  issue: IssueSummary;
  prUrl: string;
  summary: string;
}): Promise<void> {
  const { state, issue, prUrl, summary } = args;
  const key = state.ticket_key;
  const ownerRepo = ownerRepoFromPrUrl(prUrl);
  if (!ownerRepo) {
    console.warn(`  ${key}: could not parse owner/repo from PR URL ${prUrl}`);
    state.status = "error";
    return;
  }

  console.log(`  🔀 ${key} merging feature PR → ${config.workflow.devBranch}`);
  const outcome = mergeFeaturePr(prUrl, state.workspace_dir ?? process.cwd());
  if (!outcome.merged) {
    console.error(`  ❌ ${key} feature merge failed: ${outcome.reason}`);
    await addComment(
      issue.id,
      `🤖 Donkai tried to auto-merge the feature PR into \`${config.workflow.devBranch}\` but \`gh pr merge\` failed:\n\n\`\`\`\n${outcome.reason}\n\`\`\`\n\nFalling back to manual handling. Please review.`,
    );
    state.status = "error";
    return;
  }
  logEvent(key, "feature_merged_to_dev", {
    prUrl,
    mergeSha: outcome.mergeSha,
  });

  const now = new Date().toISOString();
  db()
    .prepare(
      `INSERT INTO dev_deploy_waits
       (ticket_key, issue_id, repo, feature_pr_url, merge_sha, check_name,
        ticket_summary, stage, coolify_deployment_uuid, stage_entered_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'awaiting_check', NULL, ?, ?)
       ON CONFLICT(ticket_key) DO UPDATE SET
         feature_pr_url = excluded.feature_pr_url,
         merge_sha      = excluded.merge_sha,
         ticket_summary = excluded.ticket_summary,
         stage          = 'awaiting_check',
         coolify_deployment_uuid = NULL,
         stage_entered_at = excluded.stage_entered_at`,
    )
    .run(
      key,
      issue.id,
      ownerRepo,
      prUrl,
      outcome.mergeSha,
      config.workflow.devDeployCheck,
      summary,
      now,
      now,
    );

  state.status = "awaiting_dev_deploy";
  await addComment(
    issue.id,
    `🤖 Feature PR merged to \`${config.workflow.devBranch}\`. Waiting on \`${config.workflow.devDeployCheck}\` to build before triggering the Coolify dev redeploy.\n\nMerge commit: \`${outcome.mergeSha ?? "(unknown)"}\``,
  );
}

// ----------------------------------------------------------------------------
// Tick: dev-side pipeline (check → redeploy → rolling PR append)
// ----------------------------------------------------------------------------

export async function pollDevDeploys(): Promise<void> {
  const rows = db()
    .prepare<[], DevDeployWaitRow>(
      "SELECT * FROM dev_deploy_waits ORDER BY created_at ASC",
    )
    .all();
  if (rows.length === 0) return;

  for (const row of rows) {
    if (row.stage === "awaiting_check") {
      await tickDevAwaitingCheck(row);
    } else if (row.stage === "awaiting_redeploy") {
      await tickDevAwaitingRedeploy(row);
    }
  }
}

async function tickDevAwaitingCheck(row: DevDeployWaitRow): Promise<void> {
  const ref = row.merge_sha ?? config.workflow.devBranch;
  const conclusion = getCheckConclusion(row.repo, ref, row.check_name);

  if (conclusion === "pending" || conclusion === "missing") return;
  if (conclusion !== "success" && conclusion !== "skipped" && conclusion !== "neutral") {
    await failDev(row, `GHA \`${row.check_name}\` finished with \`${conclusion}\``);
    return;
  }

  // GHA green — trigger Coolify dev redeploy.
  const appUuid = appUuidForRepo(row.repo, "DEV");
  if (!appUuid) {
    await failDev(
      row,
      `No Coolify dev app UUID configured for repo \`${row.repo}\` (set COOLIFY_APP_<REPO>_DEV)`,
    );
    return;
  }

  console.log(`  🚀 ${row.ticket_key} triggering Coolify dev redeploy (${appUuid})`);
  const trigger = await triggerRedeploy(appUuid);
  if (!trigger.ok || !trigger.deploymentUuid) {
    await failDev(
      row,
      `Coolify dev redeploy trigger failed: ${trigger.reason ?? "unknown"}`,
    );
    return;
  }

  const now = new Date().toISOString();
  db()
    .prepare(
      `UPDATE dev_deploy_waits
         SET stage = 'awaiting_redeploy',
             coolify_deployment_uuid = ?,
             stage_entered_at = ?
       WHERE ticket_key = ?`,
    )
    .run(trigger.deploymentUuid, now, row.ticket_key);

  const state = getSession(row.ticket_key);
  if (state) {
    state.status = "awaiting_dev_redeploy";
    upsertSession(state);
  }
  logEvent(row.ticket_key, "dev_redeploy_triggered", {
    deploymentUuid: trigger.deploymentUuid,
  });

  const issue = await safeGetIssue(row.issue_id);
  if (issue) {
    await addComment(
      issue.id,
      `🤖 Dev GHA green. Triggered Coolify redeploy for \`${row.repo}\` (deployment \`${trigger.deploymentUuid}\`). Waiting for it to finish before promoting to the rolling PR.`,
    );
  }
}

async function tickDevAwaitingRedeploy(row: DevDeployWaitRow): Promise<void> {
  if (!row.coolify_deployment_uuid) {
    await failDev(row, "internal: awaiting_redeploy without deployment UUID");
    return;
  }

  const status = await getDeploymentStatus(row.coolify_deployment_uuid);
  if (timedOut(row.stage_entered_at)) {
    await failDev(
      row,
      `Coolify dev deployment \`${row.coolify_deployment_uuid}\` exceeded COOLIFY_DEPLOY_TIMEOUT_SECS (${config.coolify.deployTimeoutSecs}s); last status: ${status}`,
    );
    return;
  }
  if (!isTerminal(status)) return;
  if (status !== "finished") {
    await failDev(
      row,
      `Coolify dev deployment finished with status \`${status}\``,
    );
    return;
  }

  await onDevPipelineComplete(row);
}

async function onDevPipelineComplete(row: DevDeployWaitRow): Promise<void> {
  const state = getSession(row.ticket_key);
  if (!state) {
    db()
      .prepare("DELETE FROM dev_deploy_waits WHERE ticket_key = ?")
      .run(row.ticket_key);
    return;
  }
  const issue = await safeGetIssue(row.issue_id);
  console.log(
    `  ✅ ${row.ticket_key} dev redeploy complete — promoting to rolling main PR`,
  );

  const rolling = ensureRollingPr(row.repo);
  if (!rolling) {
    console.error(
      `  ${row.ticket_key}: failed to find/create rolling main PR for ${row.repo}`,
    );
    return; // next tick retries
  }

  appendTicketToRollingPr(rolling, row);

  db()
    .prepare("DELETE FROM dev_deploy_waits WHERE ticket_key = ?")
    .run(row.ticket_key);

  state.pr_urls = Array.from(
    new Set([...state.pr_urls, row.feature_pr_url, rolling.url]),
  );
  state.status = "awaiting_review";
  upsertSession(state);
  teardownWorkspace(state.workspace_dir);

  if (issue) {
    await transitionIssue(issue.id, config.states.review);
    await addComment(
      issue.id,
      `🤖 Deployed to dev (\`${config.workflow.devDeployCheck}\` green, Coolify redeploy finished).\n\nAdded to rolling promotion PR: ${rolling.url}\n\nTest on dev. When happy, merge that PR — Donkai will trigger the prod redeploy automatically.`,
    );
  }
  logEvent(row.ticket_key, "promoted_to_rolling_main_pr", {
    rollingPr: rolling.url,
  });
}

async function failDev(row: DevDeployWaitRow, reason: string): Promise<void> {
  console.error(`  ❌ ${row.ticket_key} dev pipeline failed: ${reason}`);
  const state = getSession(row.ticket_key);
  if (state) {
    state.status = "error";
    upsertSession(state);
  }
  const issue = await safeGetIssue(row.issue_id);
  if (issue) {
    await addComment(
      issue.id,
      `🤖 Dev pipeline failed: ${reason}\n\nThe change is already on \`${config.workflow.devBranch}\` but did not deploy cleanly. Human intervention needed.`,
    );
    try {
      await transitionIssue(issue.id, config.states.waiting);
    } catch {
      /* ignore */
    }
  }
  db()
    .prepare("DELETE FROM dev_deploy_waits WHERE ticket_key = ?")
    .run(row.ticket_key);
  logEvent(row.ticket_key, "dev_pipeline_failed", { reason });
}

// ----------------------------------------------------------------------------
// Rolling PR: detect human merge → start prod promotion pipeline
// ----------------------------------------------------------------------------

export async function pollRollingMainPrs(): Promise<void> {
  const rows = db()
    .prepare<[], RollingPrRow>("SELECT * FROM rolling_main_prs")
    .all();

  for (const row of rows) {
    const info = getPrInfo(row.repo, row.pr_number);
    if (!info) continue;
    if (info.state === "OPEN") continue;

    const ticketKeys = JSON.parse(row.ticket_keys) as string[];
    if (info.state === "MERGED") {
      console.log(
        `  🚀 rolling ${row.repo} #${row.pr_number} merged — starting prod promotion pipeline`,
      );
      enqueueProdPromotion({
        repo: row.repo,
        prUrl: info.url,
        ticketKeys,
        mergeSha: info.mergeCommitOid ?? config.workflow.mainBranch,
      });
      logEvent(null, "rolling_main_pr_merged", {
        repo: row.repo,
        prUrl: info.url,
        tickets: ticketKeys,
      });
    } else {
      console.log(
        `  ⚠️  rolling ${row.repo} #${row.pr_number} closed without merge — ${ticketKeys.length} tickets left in Review`,
      );
      logEvent(null, "rolling_main_pr_closed", {
        repo: row.repo,
        prUrl: info.url,
        tickets: ticketKeys,
      });
    }
    db().prepare("DELETE FROM rolling_main_prs WHERE repo = ?").run(row.repo);
  }
}

function enqueueProdPromotion(args: {
  repo: string;
  prUrl: string;
  ticketKeys: string[];
  mergeSha: string;
}): void {
  const mergeSha = args.mergeSha;
  const now = new Date().toISOString();
  db()
    .prepare(
      `INSERT INTO prod_promotions
       (repo, pr_url, merge_sha, ticket_keys, check_name, stage,
        coolify_deployment_uuid, stage_entered_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'awaiting_main_check', NULL, ?, ?)
       ON CONFLICT(repo) DO UPDATE SET
         pr_url = excluded.pr_url,
         merge_sha = excluded.merge_sha,
         ticket_keys = excluded.ticket_keys,
         check_name = excluded.check_name,
         stage = 'awaiting_main_check',
         coolify_deployment_uuid = NULL,
         stage_entered_at = excluded.stage_entered_at`,
    )
    .run(
      args.repo,
      args.prUrl,
      mergeSha,
      JSON.stringify(args.ticketKeys),
      config.workflow.mainDeployCheck,
      now,
      now,
    );
}

// ----------------------------------------------------------------------------
// Tick: prod-side pipeline (main check → prod redeploy → close tickets)
// ----------------------------------------------------------------------------

export async function pollProdPromotions(): Promise<void> {
  const rows = db()
    .prepare<[], ProdPromotionRow>(
      "SELECT * FROM prod_promotions ORDER BY created_at ASC",
    )
    .all();
  if (rows.length === 0) return;

  for (const row of rows) {
    if (row.stage === "awaiting_main_check") {
      await tickProdAwaitingCheck(row);
    } else if (row.stage === "awaiting_prod_redeploy") {
      await tickProdAwaitingRedeploy(row);
    }
  }
}

async function tickProdAwaitingCheck(row: ProdPromotionRow): Promise<void> {
  const conclusion = getCheckConclusion(row.repo, row.merge_sha, row.check_name);
  if (conclusion === "pending" || conclusion === "missing") return;
  if (conclusion !== "success" && conclusion !== "skipped" && conclusion !== "neutral") {
    await failProd(row, `main GHA \`${row.check_name}\` finished with \`${conclusion}\``);
    return;
  }

  const appUuid = appUuidForRepo(row.repo, "PROD");
  if (!appUuid) {
    await failProd(
      row,
      `No Coolify prod app UUID configured for repo \`${row.repo}\` (set COOLIFY_APP_<REPO>_PROD)`,
    );
    return;
  }

  console.log(
    `  🚀 ${row.repo} triggering Coolify prod redeploy (${appUuid})`,
  );
  const trigger = await triggerRedeploy(appUuid);
  if (!trigger.ok || !trigger.deploymentUuid) {
    await failProd(
      row,
      `Coolify prod redeploy trigger failed: ${trigger.reason ?? "unknown"}`,
    );
    return;
  }

  const now = new Date().toISOString();
  db()
    .prepare(
      `UPDATE prod_promotions
         SET stage = 'awaiting_prod_redeploy',
             coolify_deployment_uuid = ?,
             stage_entered_at = ?
       WHERE repo = ?`,
    )
    .run(trigger.deploymentUuid, now, row.repo);
  logEvent(null, "prod_redeploy_triggered", {
    repo: row.repo,
    deploymentUuid: trigger.deploymentUuid,
    tickets: JSON.parse(row.ticket_keys) as string[],
  });
}

async function tickProdAwaitingRedeploy(row: ProdPromotionRow): Promise<void> {
  if (!row.coolify_deployment_uuid) {
    await failProd(row, "internal: awaiting_prod_redeploy without deployment UUID");
    return;
  }
  const status: CoolifyDeploymentStatus = await getDeploymentStatus(
    row.coolify_deployment_uuid,
  );
  if (timedOut(row.stage_entered_at)) {
    await failProd(
      row,
      `Coolify prod deployment \`${row.coolify_deployment_uuid}\` exceeded COOLIFY_DEPLOY_TIMEOUT_SECS (${config.coolify.deployTimeoutSecs}s); last status: ${status}`,
    );
    return;
  }
  if (!isTerminal(status)) return;
  if (status !== "finished") {
    await failProd(row, `Coolify prod deployment finished with status \`${status}\``);
    return;
  }

  await onProdPipelineComplete(row);
}

async function onProdPipelineComplete(row: ProdPromotionRow): Promise<void> {
  const ticketKeys = JSON.parse(row.ticket_keys) as string[];
  console.log(
    `  ✅ prod redeploy complete for ${row.repo} — closing ${ticketKeys.length} tickets`,
  );
  for (const key of ticketKeys) {
    await finalizeTicketOnPromote(key, row.pr_url);
  }
  db().prepare("DELETE FROM prod_promotions WHERE repo = ?").run(row.repo);
  logEvent(null, "prod_pipeline_complete", {
    repo: row.repo,
    prUrl: row.pr_url,
    tickets: ticketKeys,
  });
}

async function failProd(row: ProdPromotionRow, reason: string): Promise<void> {
  const ticketKeys = JSON.parse(row.ticket_keys) as string[];
  console.error(`  ❌ prod pipeline failed for ${row.repo}: ${reason}`);
  for (const key of ticketKeys) {
    const state = getSession(key);
    if (!state) continue;
    try {
      await addComment(
        state.issue_id,
        `🤖 Prod pipeline halted: ${reason}\n\nTicket left in Review. Human action required.`,
      );
    } catch {
      /* ignore */
    }
  }
  db().prepare("DELETE FROM prod_promotions WHERE repo = ?").run(row.repo);
  logEvent(null, "prod_pipeline_failed", {
    repo: row.repo,
    reason,
    tickets: ticketKeys,
  });
}

async function finalizeTicketOnPromote(
  ticketKey: string,
  rollingPrUrl: string,
): Promise<void> {
  const state = getSession(ticketKey);
  if (!state) return;
  state.status = "done";
  upsertSession(state);
  try {
    await transitionIssue(state.issue_id, config.states.done);
    await addComment(
      state.issue_id,
      `🤖 Promoted to \`${config.workflow.mainBranch}\` via ${rollingPrUrl} and deployed to prod. Closing.`,
    );
  } catch (err) {
    console.warn(`  failed to finalize ${ticketKey}: ${err}`);
  }
}

// ----------------------------------------------------------------------------
// Rolling PR helpers
// ----------------------------------------------------------------------------

function ensureRollingPr(repo: string): RollingPrInfo | null {
  const existing = db()
    .prepare<[string], RollingPrRow>(
      "SELECT * FROM rolling_main_prs WHERE repo = ?",
    )
    .get(repo);

  if (existing) {
    const info = getPrInfo(existing.repo, existing.pr_number);
    if (info && info.state === "OPEN") return info;
    db().prepare("DELETE FROM rolling_main_prs WHERE repo = ?").run(repo);
  }

  const liveOpen = findOpenPr(
    repo,
    config.workflow.devBranch,
    config.workflow.mainBranch,
  );
  if (liveOpen) {
    const now = new Date().toISOString();
    db()
      .prepare(
        `INSERT INTO rolling_main_prs (repo, pr_number, pr_url, ticket_keys, created_at, updated_at)
         VALUES (?, ?, ?, '[]', ?, ?)`,
      )
      .run(repo, liveOpen.number, liveOpen.url, now, now);
    return liveOpen;
  }

  const created = createPr(
    repo,
    config.workflow.devBranch,
    config.workflow.mainBranch,
    `🤖 Promote ${config.workflow.devBranch} → ${config.workflow.mainBranch}`,
    initialRollingPrBody(),
  );
  if (!created) return null;
  const now = new Date().toISOString();
  db()
    .prepare(
      `INSERT INTO rolling_main_prs (repo, pr_number, pr_url, ticket_keys, created_at, updated_at)
       VALUES (?, ?, ?, '[]', ?, ?)`,
    )
    .run(repo, created.number, created.url, now, now);
  return created;
}

function initialRollingPrBody(): string {
  return [
    "## Rolling promotion PR",
    "",
    "This PR accumulates changes from `" +
      config.workflow.devBranch +
      "` to be promoted to `" +
      config.workflow.mainBranch +
      "`.",
    "",
    "**Do not merge until all listed changes have been tested on dev.**",
    "On merge, Donkai will wait for the main GHA, trigger a Coolify prod redeploy, then close the listed tickets.",
    "",
    "### Included tickets",
    "",
    "_(none yet)_",
    "",
    TICKET_MARKER_START,
    TICKET_MARKER_END,
  ].join("\n");
}

const TICKET_MARKER_START = "<!-- donkai:tickets-start -->";
const TICKET_MARKER_END = "<!-- donkai:tickets-end -->";

function appendTicketToRollingPr(
  pr: RollingPrInfo,
  row: DevDeployWaitRow,
): void {
  const stored = db()
    .prepare<[string], RollingPrRow>(
      "SELECT * FROM rolling_main_prs WHERE repo = ?",
    )
    .get(row.repo);
  const keys: string[] = stored
    ? (JSON.parse(stored.ticket_keys) as string[])
    : [];
  if (!keys.includes(row.ticket_key)) keys.push(row.ticket_key);

  const entry = `- **${row.ticket_key}** — ${row.ticket_summary ?? "(no summary)"} _(feature PR: ${row.feature_pr_url})_`;
  const newBody = injectEntry(pr.body, entry);
  updatePrBody(row.repo, pr.number, newBody);

  db()
    .prepare(
      `UPDATE rolling_main_prs
         SET ticket_keys = ?, updated_at = ?
       WHERE repo = ?`,
    )
    .run(JSON.stringify(keys), new Date().toISOString(), row.repo);
}

function injectEntry(body: string, entry: string): string {
  if (body.includes(TICKET_MARKER_START) && body.includes(TICKET_MARKER_END)) {
    const before = body.split(TICKET_MARKER_START)[0]!;
    const between = body
      .split(TICKET_MARKER_START)[1]!
      .split(TICKET_MARKER_END)[0]!;
    const after = body.split(TICKET_MARKER_END)[1] ?? "";
    const trimmed = between
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => l !== "_(none yet)_");
    trimmed.push(entry);
    return `${before}${TICKET_MARKER_START}\n${trimmed.join("\n")}\n${TICKET_MARKER_END}${after}`;
  }
  return `${body}\n\n${TICKET_MARKER_START}\n${entry}\n${TICKET_MARKER_END}`;
}

// ----------------------------------------------------------------------------
// Misc
// ----------------------------------------------------------------------------

async function safeGetIssue(issueId: string): Promise<IssueSummary | null> {
  try {
    return await getIssue(issueId);
  } catch {
    return null;
  }
}

function timedOut(stageEnteredAt: string | null): boolean {
  if (!stageEnteredAt) return false;
  const elapsed = Date.now() - new Date(stageEnteredAt).getTime();
  return elapsed > config.coolify.deployTimeoutSecs * 1000;
}
