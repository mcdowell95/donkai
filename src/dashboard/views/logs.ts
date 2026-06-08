import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { escape } from "./layout.js";

const MAX_LINES = 400;
const MAX_BYTES = 512 * 1024;

interface ParsedEntry {
  ts: string;
  kind: string;
  body: string;
}

export function renderLogFragment(workspaceDir: string | null): string {
  if (!workspaceDir) {
    return `<p class="empty">No workspace recorded yet for this session.</p>`;
  }
  const path = join(workspaceDir, "cc.log");
  if (!existsSync(path)) {
    return `<p class="empty">cc.log not yet written.</p>`;
  }

  const buf = readTail(path, MAX_BYTES);
  const lines = buf.split("\n").filter(Boolean).slice(-MAX_LINES);
  const entries = lines.map(parseLine);

  const stat = statSync(path);
  const sizeKb = (stat.size / 1024).toFixed(1);
  const mtime = stat.mtime.toISOString();

  const rendered = entries
    .map(
      (e) =>
        `<div class="log-entry log-${escape(e.kind)}"><span class="log-ts">${escape(e.ts)}</span><span class="log-kind">${escape(e.kind)}</span><pre class="log-body">${escape(e.body)}</pre></div>`,
    )
    .join("");

  return `<div class="log-meta">${sizeKb} KB · last write ${escape(mtime)} · showing last ${entries.length} entries</div>${rendered || `<p class="empty">Log empty.</p>`}`;
}

function readTail(path: string, maxBytes: number): string {
  const size = statSync(path).size;
  if (size <= maxBytes) return readFileSync(path, "utf-8");
  const fd = readFileSync(path);
  return fd.slice(size - maxBytes).toString("utf-8");
}

function parseLine(line: string): ParsedEntry {
  const ts = new Date().toISOString().slice(11, 19);
  try {
    const obj = JSON.parse(line) as {
      type?: string;
      subtype?: string;
      session_id?: string;
      result?: string;
      is_error?: boolean;
      total_cost_usd?: number;
      message?: {
        role?: string;
        model?: string;
        content?: Array<{
          type?: string;
          text?: string;
          name?: string;
          input?: unknown;
          content?: unknown;
          tool_use_id?: string;
        }>;
      };
    };

    if (obj.type === "system" && obj.subtype === "init") {
      return { ts, kind: "system", body: `init · session=${obj.session_id ?? "?"}` };
    }

    if (obj.type === "assistant" && obj.message?.content) {
      const parts: string[] = [];
      for (const c of obj.message.content) {
        if (c.type === "text" && c.text) parts.push(c.text);
        else if (c.type === "tool_use") {
          parts.push(`🔧 ${c.name ?? "tool"}(${truncJson(c.input)})`);
        }
      }
      return { ts, kind: "assistant", body: parts.join("\n").slice(0, 4000) };
    }

    if (obj.type === "user" && obj.message?.content) {
      const parts: string[] = [];
      for (const c of obj.message.content) {
        if (c.type === "tool_result") {
          const txt =
            typeof c.content === "string"
              ? c.content
              : truncJson(c.content);
          parts.push(`← ${txt}`);
        }
      }
      return { ts, kind: "tool_result", body: parts.join("\n").slice(0, 4000) };
    }

    if (obj.type === "result") {
      const cost =
        obj.total_cost_usd != null ? ` · $${obj.total_cost_usd.toFixed(4)}` : "";
      const body = `${obj.is_error ? "ERROR " : ""}${obj.result ?? "(no result)"}${cost}`;
      return { ts, kind: "result", body: body.slice(0, 4000) };
    }

    return { ts, kind: obj.type ?? "raw", body: truncJson(obj) };
  } catch {
    return { ts, kind: "raw", body: line.slice(0, 2000) };
  }
}

function truncJson(value: unknown): string {
  const str = JSON.stringify(value);
  if (!str) return "";
  return str.length > 1000 ? str.slice(0, 1000) + "…" : str;
}
