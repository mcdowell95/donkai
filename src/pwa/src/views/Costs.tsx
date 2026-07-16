import { api } from "../api";
import { usePoll, fmtUsd } from "../hooks";
import type { CostsResponse } from "../types";

export function Costs() {
  const { data, error } = usePoll(() => api<CostsResponse>("/costs?days=30"), 30000);

  if (!data && !error) return <div class="loading">Loading…</div>;

  const today = new Date().toISOString().slice(0, 10);
  const todayRow = data?.daily.find((d) => d.day === today);
  const total30 = data?.daily.reduce((sum, d) => sum + d.cost, 0) ?? 0;

  return (
    <div class="view">
      <div class="view-head">
        <h1>Costs</h1>
      </div>

      {data && (
        <>
          <div class="stat-row">
            <div class="stat">
              <span class="stat-value">{fmtUsd(todayRow?.cost ?? 0)}</span>
              <span class="stat-label">today</span>
            </div>
            <div class="stat">
              <span class="stat-value">{fmtUsd(total30)}</span>
              <span class="stat-label">30 days</span>
            </div>
            <div class="stat">
              <span class="stat-value">{todayRow?.tickets ?? 0}</span>
              <span class="stat-label">tickets today</span>
            </div>
          </div>

          <h2 class="section-title">Daily</h2>
          <div class="card table-card">
            <table>
              <thead>
                <tr><th>Day</th><th class="num">Cost</th><th class="num">Tickets</th></tr>
              </thead>
              <tbody>
                {data.daily.length === 0 && (
                  <tr><td colSpan={3} class="muted">No spend recorded.</td></tr>
                )}
                {[...data.daily].reverse().map((d) => (
                  <tr key={d.day}>
                    <td>{d.day}</td>
                    <td class="num">{fmtUsd(d.cost)}</td>
                    <td class="num">{d.tickets}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2 class="section-title">Per ticket</h2>
          <div class="card table-card">
            <table>
              <thead>
                <tr><th>Ticket</th><th class="num">Total</th><th class="num">Calls</th></tr>
              </thead>
              <tbody>
                {data.perTicket.length === 0 && (
                  <tr><td colSpan={3} class="muted">No tickets yet.</td></tr>
                )}
                {data.perTicket.map((t) => (
                  <tr key={t.ticket_key}>
                    <td class="ticket-key">{t.ticket_key}</td>
                    <td class="num">{fmtUsd(t.total)}</td>
                    <td class="num">{t.calls}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {error && <p class="error-text">Connection problem: {error}</p>}
    </div>
  );
}
