import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../api";
import { usePoll, navigate, fmtAgo } from "../hooks";
import { StatusBadge } from "../components/StatusBadge";
import { prUrls, type LogChunk, type SessionDetail } from "../types";

const MAX_LOG_LINES = 1000;

function LogTail({ ticketKey }: { ticketKey: string }) {
  const [lines, setLines] = useState<string[]>([]);
  const offsetRef = useRef<number | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    offsetRef.current = null;
    setLines([]);
    stickRef.current = true;
    let alive = true;

    const poll = async () => {
      try {
        const query =
          offsetRef.current == null ? "?tail=200" : `?after=${offsetRef.current}`;
        const chunk = await api<LogChunk>(
          `/sessions/${encodeURIComponent(ticketKey)}/logs${query}`
        );
        if (!alive) return;
        const first = offsetRef.current == null;
        offsetRef.current = chunk.offset;
        if (chunk.lines.length > 0) {
          setLines((prev) =>
            (first ? chunk.lines : [...prev, ...chunk.lines]).slice(-MAX_LOG_LINES)
          );
        }
      } catch {
        /* transient; retry on next tick */
      }
    };

    void poll();
    const id = setInterval(() => void poll(), 2500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [ticketKey]);

  useEffect(() => {
    const el = boxRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div
      class="log-box"
      ref={boxRef}
      onScroll={(e) => {
        const el = e.target as HTMLDivElement;
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}
    >
      {lines.length === 0 ? (
        <span class="log-line muted">— no log output yet —</span>
      ) : (
        lines.map((line, i) => (
          <span key={i} class="log-line">
            {line}
          </span>
        ))
      )}
    </div>
  );
}

export function TicketDetail({ ticketKey }: { ticketKey: string }) {
  const { data, error, refresh } = usePoll(
    () => api<SessionDetail>(`/sessions/${encodeURIComponent(ticketKey)}`),
    4000,
    [ticketKey]
  );
  const [replyText, setReplyText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const doAction = async (name: string, path: string, body?: unknown) => {
    setBusy(name);
    setActionError(null);
    try {
      await api(`/sessions/${encodeURIComponent(ticketKey)}/${path}`, {
        method: "POST",
        body,
      });
      if (name === "respond") setReplyText("");
      await refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  if (!data && !error) return <div class="loading">Loading…</div>;
  if (!data) {
    return (
      <div class="view">
        <button class="btn back-btn" onClick={() => navigate("/")}>← Back</button>
        <p class="error-text">Could not load {ticketKey}: {error}</p>
      </div>
    );
  }

  const urls = prUrls(data.pr_urls);

  return (
    <div class="view">
      <button class="btn back-btn" onClick={() => navigate("/")}>← Back</button>

      <div class="card">
        <div class="card-head">
          <span class="ticket-key ticket-key-lg">{data.ticket_key}</span>
          <StatusBadge status={data.status} />
        </div>
        {data.summary && <p class="summary">{data.summary}</p>}
        <div class="detail-meta">
          {data.repo && (
            <div class="detail-row"><span class="muted">Repo</span><span>{data.repo}</span></div>
          )}
          {data.branch_name && (
            <div class="detail-row"><span class="muted">Branch</span><span class="mono">{data.branch_name}</span></div>
          )}
          {data.queuePosition != null && (
            <div class="detail-row"><span class="muted">Queue position</span><span>#{data.queuePosition}</span></div>
          )}
          <div class="detail-row"><span class="muted">Updated</span><span>{fmtAgo(data.updated_at)}</span></div>
        </div>
        {urls.length > 0 && (
          <div class="pr-links">
            {urls.map((url) => (
              <a key={url} href={url} target="_blank" rel="noopener noreferrer" class="pr-link">
                PR ↗
              </a>
            ))}
          </div>
        )}
      </div>

      {data.status === "suspended_local" && (
        <div class="card card-attention">
          {data.pending_question && <p class="question-text">❓ {data.pending_question}</p>}
          <div class="reply-box">
            <textarea
              placeholder="Type your answer…"
              value={replyText}
              rows={3}
              onInput={(e) => setReplyText((e.target as HTMLTextAreaElement).value)}
            />
            <button
              class="btn btn-primary"
              disabled={busy !== null || !replyText.trim()}
              onClick={() => void doAction("respond", "respond", { text: replyText.trim() })}
            >
              {busy === "respond" ? "Sending…" : "Send answer"}
            </button>
          </div>
        </div>
      )}

      <div class="action-row">
        {data.status === "error" && (
          <button
            class="btn btn-danger"
            disabled={busy !== null}
            onClick={() => void doAction("retry", "retry")}
          >
            {busy === "retry" ? "Retrying…" : "Retry"}
          </button>
        )}
        <button
          class="btn"
          disabled={busy !== null}
          onClick={() => void doAction("takeover", "takeover")}
        >
          {busy === "takeover" ? "…" : "Take over"}
        </button>
        <button
          class="btn"
          disabled={busy !== null}
          onClick={() => void doAction("release", "release")}
        >
          {busy === "release" ? "…" : "Release"}
        </button>
      </div>
      {actionError && <p class="error-text">{actionError}</p>}

      <h2 class="section-title">Live log</h2>
      <LogTail ticketKey={ticketKey} />
    </div>
  );
}
