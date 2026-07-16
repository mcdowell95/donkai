import { useEffect, useState } from "preact/hooks";
import { api, clearToken } from "../api";
import { currentSubscription, pushSupported, subscribePush, unsubscribePush } from "../push";
import { priorityLabel, type Learning, type Rule } from "../types";

function RulesSection() {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ team_key: "", label: "", max_priority_num: "", repo: "", note: "" });
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setRules(await api<Rule[]>("/rules"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const toggle = async (rule: Rule) => {
    try {
      await api(`/rules/${rule.id}`, {
        method: "PUT",
        body: {
          team_key: rule.team_key,
          label: rule.label,
          max_priority_num: rule.max_priority_num,
          repo: rule.repo,
          note: rule.note,
          enabled: !rule.enabled,
        },
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (id: number) => {
    try {
      await api(`/rules/${id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const add = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body: Record<string, unknown> = {};
      if (form.team_key.trim()) body.team_key = form.team_key.trim();
      if (form.label.trim()) body.label = form.label.trim();
      if (form.max_priority_num) body.max_priority_num = Number(form.max_priority_num);
      if (form.repo.trim()) body.repo = form.repo.trim();
      if (form.note.trim()) body.note = form.note.trim();
      await api("/rules", { method: "POST", body });
      setForm({ team_key: "", label: "", max_priority_num: "", repo: "", note: "" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const set = (key: keyof typeof form) => (e: Event) =>
    setForm({ ...form, [key]: (e.target as HTMLInputElement).value });

  return (
    <section>
      <h2 class="section-title">Pickup rules</h2>
      {rules == null && <div class="loading">Loading…</div>}
      {rules?.length === 0 && <p class="muted empty">No rules — nothing gets picked up.</p>}
      {rules?.map((rule) => (
        <div class={`card rule-row${rule.enabled ? "" : " rule-disabled"}`} key={rule.id}>
          <div class="rule-body">
            <div class="rule-desc">
              {rule.team_key && <span class="meta-chip">team {rule.team_key}</span>}
              {rule.label && <span class="meta-chip">label {rule.label}</span>}
              {rule.max_priority_num != null && (
                <span class="meta-chip">≥ {priorityLabel(rule.max_priority_num)}</span>
              )}
              {rule.repo && <span class="meta-chip">{rule.repo}</span>}
            </div>
            {rule.note && <p class="muted rule-note">{rule.note}</p>}
          </div>
          <div class="rule-actions">
            <button
              class={`switch${rule.enabled ? " switch-on" : ""}`}
              role="switch"
              aria-checked={!!rule.enabled}
              onClick={() => void toggle(rule)}
            >
              <span class="switch-knob" />
            </button>
            <button class="btn btn-icon btn-danger" onClick={() => void remove(rule.id)} aria-label="Delete rule">✕</button>
          </div>
        </div>
      ))}

      <form class="card add-rule-form" onSubmit={add}>
        <h3>Add rule</h3>
        <input placeholder="Team key (e.g. ENG)" value={form.team_key} onInput={set("team_key")} />
        <input placeholder="Label" value={form.label} onInput={set("label")} />
        <select
          value={form.max_priority_num}
          onChange={(e) => setForm({ ...form, max_priority_num: (e.target as HTMLSelectElement).value })}
        >
          <option value="">Max priority (any)</option>
          <option value="1">Urgent</option>
          <option value="2">High</option>
          <option value="3">Medium</option>
          <option value="4">Low</option>
        </select>
        <input placeholder="Repo" value={form.repo} onInput={set("repo")} />
        <input placeholder="Note" value={form.note} onInput={set("note")} />
        <button type="submit" class="btn btn-primary" disabled={busy}>
          {busy ? "Adding…" : "Add rule"}
        </button>
      </form>
      {error && <p class="error-text">{error}</p>}
    </section>
  );
}

function PushSection() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = pushSupported();

  useEffect(() => {
    if (!supported) {
      setEnabled(false);
      return;
    }
    void currentSubscription().then((sub) => setEnabled(!!sub));
  }, [supported]);

  const toggle = async () => {
    if (busy || enabled == null) return;
    setBusy(true);
    setError(null);
    try {
      if (enabled) {
        await unsubscribePush();
        setEnabled(false);
      } else {
        await subscribePush();
        setEnabled(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2 class="section-title">Notifications</h2>
      <div class="card rule-row">
        <div class="rule-body">
          <span>Push notifications</span>
          {!supported && <p class="muted rule-note">Not supported in this browser.</p>}
        </div>
        <button
          class={`switch${enabled ? " switch-on" : ""}`}
          role="switch"
          aria-checked={!!enabled}
          disabled={!supported || busy || enabled == null}
          onClick={() => void toggle()}
        >
          <span class="switch-knob" />
        </button>
      </div>
      {error && <p class="error-text">{error}</p>}
    </section>
  );
}

function LearningsSection() {
  const [learnings, setLearnings] = useState<Learning[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setLearnings(await api<Learning[]>("/learnings"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const decide = async (id: number, verdict: "accept" | "reject") => {
    try {
      await api(`/learnings/${id}/${verdict}`, { method: "POST" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const parse = (raw: string): { proposal?: string; section?: string } => {
    try {
      return JSON.parse(raw) as { proposal?: string; section?: string };
    } catch {
      return { proposal: raw };
    }
  };

  return (
    <section>
      <h2 class="section-title">Pending learnings</h2>
      {learnings == null && <div class="loading">Loading…</div>}
      {learnings?.length === 0 && <p class="muted empty">Nothing to review.</p>}
      {learnings?.map((l) => {
        const p = parse(l.proposal);
        return (
          <div class="card" key={l.id}>
            <div class="card-head">
              <span class="ticket-key">{l.ticket_key}</span>
              {p.section && <span class="meta-chip">{p.section}</span>}
            </div>
            <p class="summary">{p.proposal}</p>
            <div class="action-row">
              <button class="btn btn-success" onClick={() => void decide(l.id, "accept")}>✓ Accept</button>
              <button class="btn btn-danger" onClick={() => void decide(l.id, "reject")}>✕ Reject</button>
            </div>
          </div>
        );
      })}
      {error && <p class="error-text">{error}</p>}
    </section>
  );
}

export function Settings({ onLogout }: { onLogout: () => void }) {
  return (
    <div class="view">
      <div class="view-head">
        <h1>Settings</h1>
      </div>
      <RulesSection />
      <PushSection />
      <LearningsSection />
      <section>
        <h2 class="section-title">Account</h2>
        <button
          class="btn btn-danger btn-block"
          onClick={() => {
            clearToken();
            onLogout();
          }}
        >
          Reset API token
        </button>
        <a class="btn btn-block classic-link" href="/classic">
          Open classic dashboard ↗
        </a>
      </section>
    </div>
  );
}
