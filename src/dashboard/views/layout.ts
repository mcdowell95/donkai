import { config } from "../../config.js";

export function layout(title: string, body: string, active: string = "home"): string {
  const sub = config.dashboard.subtitle
    ? `<span class="subtitle">${escape(config.dashboard.subtitle)}</span>`
    : "";

  const tabs = [
    { key: "home", label: "Workers", href: "/" },
    { key: "queue", label: "Queue", href: "/queue" },
    { key: "merges", label: "Merges", href: "/merges" },
    { key: "learnings", label: "Learnings", href: "/learnings" },
    { key: "costs", label: "Costs", href: "/costs" },
    { key: "events", label: "Events", href: "/events" },
  ];

  const tabHtml = tabs
    .map(
      (t) =>
        `<a class="tab ${t.key === active ? "active" : ""}" href="${t.href}">${t.label}</a>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escape(title)} — Donkai</title>
  <link rel="stylesheet" href="/static/style.css" />
  <script src="https://unpkg.com/htmx.org@1.9.12" crossorigin="anonymous"></script>
</head>
<body>
  <header>
    <h1>Donkai ${sub}</h1>
    <div class="meta">
      <span class="badge mode-${config.concurrency.mode}">${config.concurrency.mode}</span>
      <span class="badge autonomy-${config.autonomy.level}">${config.autonomy.level}</span>
    </div>
  </header>
  <nav>${tabHtml}</nav>
  <main>${body}</main>
</body>
</html>`;
}

export function escape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
