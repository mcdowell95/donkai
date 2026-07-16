import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { priorityLabel, type QueueItem } from "../types";

export function Queue() {
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      const rows = await api<QueueItem[]>("/queue");
      setItems(rows);
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const move = (index: number, delta: number) => {
    if (!items) return;
    const to = index + delta;
    if (to < 0 || to >= items.length) return;
    const next = [...items];
    const [row] = next.splice(index, 1);
    next.splice(to, 0, row);
    setItems(next);
    setDirty(true);
  };

  const apply = async () => {
    if (!items) return;
    setBusy(true);
    setError(null);
    try {
      await api("/queue/order", {
        method: "PUT",
        body: { order: items.map((i) => i.ticket_key) },
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="view">
      <div class="view-head">
        <h1>Queue</h1>
        <button class="btn btn-small" onClick={() => void load()}>↻ Refresh</button>
      </div>

      {items == null && !error && <div class="loading">Loading…</div>}
      {items != null && items.length === 0 && <p class="muted empty">Queue is empty.</p>}

      {items?.map((item, i) => (
        <div class="card queue-row" key={item.ticket_key}>
          <div class="queue-pos">{i + 1}</div>
          <div class="queue-body">
            <span class="ticket-key">{item.ticket_key}</span>
            <div class="card-meta">
              <span class={`meta-chip prio-${item.priority ?? 0}`}>{priorityLabel(item.priority)}</span>
              {item.repo && <span class="meta-chip">{item.repo}</span>}
            </div>
          </div>
          <div class="queue-arrows">
            <button class="btn btn-icon" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">▲</button>
            <button class="btn btn-icon" disabled={i === items.length - 1} onClick={() => move(i, 1)} aria-label="Move down">▼</button>
          </div>
        </div>
      ))}

      {dirty && (
        <button class="btn btn-primary btn-block apply-btn" disabled={busy} onClick={() => void apply()}>
          {busy ? "Applying…" : "Apply order"}
        </button>
      )}
      {error && <p class="error-text">{error}</p>}
    </div>
  );
}
