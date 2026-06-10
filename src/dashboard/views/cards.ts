import { escape } from "./layout.js";
import type { WorkerState } from "../../registry/sessions.js";

const statusColor: Record<string, string> = {
  running: "running",
  queued: "queued",
  pending: "queued",
  suspended_local: "needs-input",
  suspended_linear: "blocked",
  awaiting_dev_deploy: "review",
  awaiting_dev_redeploy: "review",
  awaiting_review: "review",
  detached: "detached",
  merged: "done",
  done: "done",
  error: "error",
};

export function workerCards(sessions: WorkerState[]): string {
  if (sessions.length === 0) {
    return `<p class="empty">No active workers. Move a Linear ticket into the "Ready for Claude" state to kick one off.</p>`;
  }

  const cards = sessions.map(renderCard).join("\n");
  return `<div class="cards">${cards}</div>`;
}

function renderCard(s: WorkerState): string {
  const colorClass = statusColor[s.status] ?? "default";

  const prLinks = s.pr_urls
    .map(
      (url) =>
        `<a class="pr-link" href="${url}" target="_blank" rel="noopener">PR ↗</a>`,
    )
    .join(" ");

  const pending = s.pending_question
    ? `
    <div class="pending">
      <div class="pending-label">Awaiting response:</div>
      <div class="pending-body">${escape(s.pending_question)}</div>
      <form hx-post="/api/respond/${escape(s.ticket_key)}" hx-target="closest .card" hx-swap="outerHTML">
        <textarea name="response" rows="3" placeholder="Your answer for Claude..."></textarea>
        <button type="submit">Send & resume</button>
      </form>
    </div>`
    : "";

  const actions = renderActions(s);

  return `<article class="card status-${colorClass}">
    <header>
      <span class="ticket">${escape(s.ticket_key)}</span>
      <span class="status">${escape(s.status)}</span>
    </header>
    <h3>${escape(s.summary ?? "(no title)")}</h3>
    <div class="meta">
      ${s.repo ? `<span class="meta-pill">repo: ${escape(s.repo)}</span>` : ""}
      ${s.branch_name ? `<span class="meta-pill">branch: ${escape(s.branch_name)}</span>` : ""}
      ${prLinks}
    </div>
    ${pending}
    <footer>
      <a class="log-link" href="/logs/${escape(s.ticket_key)}">View logs</a>
      ${actions}
    </footer>
  </article>`;
}

function renderActions(s: WorkerState): string {
  const t = (action: string, label: string) =>
    `<button hx-post="/api/${action}/${escape(s.ticket_key)}" hx-target="closest .card" hx-swap="outerHTML">${label}</button>`;
  switch (s.status) {
    case "running":
      return t("takeover", "Takeover");
    case "detached":
      return t("release", "Release back to Donkai");
    case "suspended_local":
    case "suspended_linear":
    case "awaiting_dev_deploy":
    case "awaiting_dev_redeploy":
    case "awaiting_review":
      return t("takeover", "Takeover");
    default:
      return "";
  }
}
