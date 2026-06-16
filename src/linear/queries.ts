import type { Issue } from "@linear/sdk";
import { config } from "../config.js";
import { findStateId, linear, teamIds, viewer } from "./client.js";

export interface IssueSummary {
  id: string;
  identifier: string;
  title: string;
  description: string;
  priority: number;
  labels: string[];
  project: string | null;
  url: string;
  stateName: string;
  comments: CommentSummary[];
}

export interface CommentSummary {
  author: "bot" | "human";
  authorName: string;
  body: string;
  createdAt: string;
}

async function expandIssue(issue: Issue): Promise<IssueSummary> {
  const [state, labels, project, comments] = await Promise.all([
    issue.state,
    issue.labels(),
    issue.project,
    issue.comments({ first: 10, orderBy: undefined }),
  ]);

  const commentSummaries: CommentSummary[] = await Promise.all(
    comments.nodes.map(async (c) => {
      const author = await c.user;
      const name = author?.name ?? "unknown";
      const isBot = c.body.startsWith("🤖");
      return {
        author: isBot ? "bot" : "human",
        authorName: name,
        body: c.body,
        createdAt: c.createdAt.toISOString(),
      };
    }),
  );

  commentSummaries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? "",
    priority: issue.priority ?? 0,
    labels: labels.nodes.map((l) => l.name),
    project: project ? (await project).name : null,
    url: issue.url,
    stateName: state ? state.name : "(unknown)",
    comments: commentSummaries,
  };
}

async function baseScopeFilter(): Promise<Record<string, unknown>> {
  const teams = await teamIds();
  const filter: Record<string, unknown> = {
    team: { id: { in: teams } },
    state: { name: { eq: config.states.ready } },
  };
  if (!config.linear.pickupLabel) {
    const me = await viewer();
    filter.assignee = { id: { eq: me.id } };
  }
  return filter;
}

function requiredLabelClauses(extra: string[] = []): Array<{ labels: { name: { eq: string } } }> {
  const names: string[] = [];
  if (config.linear.pickupLabel) names.push(config.linear.pickupLabel);
  for (const n of extra) names.push(n);
  return names.map((name) => ({ labels: { name: { eq: name } } }));
}

export async function findReadyIssues(): Promise<IssueSummary[]> {
  const base = await baseScopeFilter();
  const labelClauses = requiredLabelClauses();
  const filter: Record<string, unknown> =
    labelClauses.length > 0 ? { ...base, and: labelClauses } : base;

  const issues = await linear().issues({
    filter,
    orderBy: undefined,
    first: 50,
  });

  return Promise.all(issues.nodes.map(expandIssue));
}

export async function findResumedIssues(): Promise<IssueSummary[]> {
  // Tickets back to "Ready for Claude" that carry the cc-suspended label.
  // When LINEAR_PICKUP_LABEL is set, both labels must be present.
  const base = await baseScopeFilter();
  const filter: Record<string, unknown> = {
    ...base,
    and: requiredLabelClauses(["cc-suspended"]),
  };

  const issues = await linear().issues({
    filter,
    first: 50,
  });

  return Promise.all(issues.nodes.map(expandIssue));
}

export async function getIssue(id: string): Promise<IssueSummary> {
  const issue = await linear().issue(id);
  return expandIssue(issue);
}

export async function addComment(issueId: string, body: string): Promise<void> {
  await linear().createComment({ issueId, body });
}

export async function transitionIssue(
  issueId: string,
  targetStateName: string,
): Promise<void> {
  const issue = await linear().issue(issueId);
  const team = await issue.team;
  if (!team) throw new Error(`Issue ${issueId} has no team`);
  const stateId = await findStateId(team.id, targetStateName);
  if (!stateId) {
    throw new Error(`No workflow state named "${targetStateName}" on team ${team.key}`);
  }
  await issue.update({ stateId });
}

export async function addLabel(issueId: string, labelName: string): Promise<void> {
  const issue = await linear().issue(issueId);
  const team = await issue.team;
  if (!team) return;

  const teamLabels = await linear().issueLabels({
    filter: { team: { id: { eq: team.id } }, name: { eq: labelName } },
  });
  let labelId = teamLabels.nodes[0]?.id;

  if (!labelId) {
    const created = await linear().createIssueLabel({
      name: labelName,
      teamId: team.id,
      color: "#9b7cff",
    });
    const label = await created.issueLabel;
    labelId = label?.id;
  }
  if (!labelId) return;

  const existing = await issue.labels();
  const ids = new Set(existing.nodes.map((l) => l.id));
  ids.add(labelId);
  await issue.update({ labelIds: Array.from(ids) });
}

export async function removeLabel(issueId: string, labelName: string): Promise<void> {
  const issue = await linear().issue(issueId);
  const existing = await issue.labels();
  const filtered = existing.nodes.filter((l) => l.name !== labelName).map((l) => l.id);
  if (filtered.length === existing.nodes.length) return;
  await issue.update({ labelIds: filtered });
}
