import { useState } from "preact/hooks";
import { api } from "../api";
import { usePoll, navigate, fmtAgo, fmtUsd } from "../hooks";
import { StatusBadge } from "../components/StatusBadge";
import { prUrls, type StatusResponse, type WorkerInfo } from "../types";

function ReplyBox({ ticketKey, onSent }: { ticketKey: string; onSent: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/sessions/${encodeURIComponent(ticketKey)}/respond`, {
        method: "POST",
        body: { text: trimmed },
      });
      setText("");
      onSent();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="reply-box" onClick={(e) => e.stopPropagation()}>
      <textarea
        placeholder="Type your answer…"
        value={text}
        rows={2}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
      />
      <button class="btn btn-primary" disabled={busy || !text.trim()} onClick={() => void send()}>
        {busy ? "Sending…" : "Send"}
      </button>
      {error && <p class="error-text">{error}</p>}
    </div>
  );
}

function WorkerCard({ worker, onChanged }: { worker: WorkerInfo; onChanged: () => void }) {
  const urls = prUrls(worker.pr_urls);
  return (
    <div
      class={`card worker-card${worker.status === "suspended_local" ? " card-attention" : ""}`}
      onClick={() => navigate(`/ticket/${encodeURIComponent(worker.ticket_key)}`)}
    >
      <div class="card-head">
        <span class="ticket-key">{worker.ticket_key}</span>
        <StatusBadge status={worker.status} />
      </div>
      {worker.summary && <p class="summary">{worker.summary}</p>}
      <div class="card-meta">
        {worker.repo && <span class="meta-chip">{worker.repo}</span>}
        <span class="meta-time">{fmtAgo(worker.updated_at)}</span>
      </div>
      {urls.length > 0 && (
        <div class="pr-links" onClick={(e) => e.stopPropagation()}>
          {urls.map((url) => (
            <a key={url} href={url} target="_blank" rel="noopener noreferrer" class="pr-link">
              PR ↗
            </a>
          ))}
        </div>
      )}
      {worker.pending_question && (
        <div class="question-block" onClick={(e) => e.stopPropagation()}>
          <p class="question-text">❓ {worker.pending_question}</p>
          <ReplyBox ticketKey={worker.ticket_key} onSent={onChanged} />
        </div>
      )}
    </div>
  );
}

export function Home() {
  const { data, error, refresh } = usePoll(() => api<StatusResponse>("/status"), 4000);
  const [toggling, setToggling] = useState(false);

  const togglePause = async () => {
    if (!data || toggling) return;
    setToggling(true);
    try {
      await api(data.paused ? "/resume" : "/pause", { method: "POST" });
      await refresh();
    } catch {
      /* surfaced on next poll */
    } finally {
      setToggling(false);
    }
  };

  if (!data && !error) return <div class="loading">Loading…</div>;

  return (
    <div class="view">
      {data && (
        <>
          <button
            class={`pause-pill ${data.paused ? "pill-paused" : "pill-running"}`}
            disabled={toggling}
            onClick={() => void togglePause()}
          >
            <span class="pill-state">{data.paused ? "⏸ PAUSED" : "▶ RUNNING"}</span>
            <span class="pill-hint">{data.paused ? "tap to resume" : "tap to pause"}</span>
          </button>

          <div class="stat-row">
            <div class="stat">
              <span class="stat-value">{data.queueLength}</span>
              <span class="stat-label">queued</span>
            </div>
            <div class="stat">
              <span class="stat-value">{fmtUsd(data.costTodayUsd)}</span>
              <span class="stat-label">today</span>
            </div>
            <div class="stat">
              <span class="stat-value">{fmtAgo(data.lastTickAt)}</span>
              <span class="stat-label">last tick</span>
            </div>
          </div>

          <h2 class="section-title">Workers</h2>
          {data.activeWorkers.length === 0 && (
            <p class="muted empty">No active workers. The donkey rests. 🫏</p>
          )}
          {data.activeWorkers.map((w) => (
            <WorkerCard key={w.ticket_key} worker={w} onChanged={() => void refresh()} />
          ))}
        </>
      )}
      {error && <p class="error-text">Connection problem: {error}</p>}
    </div>
  );
}
