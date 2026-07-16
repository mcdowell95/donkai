import { db } from "../registry/db.js";
import type { IssueSummary } from "../linear/queries.js";
import { inferRepo } from "../orchestrator/queue.js";

export interface PickupRule {
  id: number;
  enabled: boolean;
  team_key: string | null;
  label: string | null;
  max_priority_num: number | null;
  repo: string | null;
  note: string | null;
  created_at: string;
}

interface RuleRow {
  id: number;
  enabled: number;
  team_key: string | null;
  label: string | null;
  max_priority_num: number | null;
  repo: string | null;
  note: string | null;
  created_at: string;
}

function rowToRule(r: RuleRow): PickupRule {
  return { ...r, enabled: r.enabled === 1 };
}

export function listRules(): PickupRule[] {
  return db()
    .prepare<[], RuleRow>("SELECT * FROM pickup_rules ORDER BY id ASC")
    .all()
    .map(rowToRule);
}

export function addRule(rule: {
  team_key?: string | null;
  label?: string | null;
  max_priority_num?: number | null;
  repo?: string | null;
  note?: string | null;
  enabled?: boolean;
}): PickupRule {
  const info = db()
    .prepare(
      `INSERT INTO pickup_rules (enabled, team_key, label, max_priority_num, repo, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      rule.enabled === false ? 0 : 1,
      rule.team_key ?? null,
      rule.label ?? null,
      rule.max_priority_num ?? null,
      rule.repo ?? null,
      rule.note ?? null,
      new Date().toISOString(),
    );
  return listRules().find((r) => r.id === Number(info.lastInsertRowid))!;
}

export function updateRule(
  id: number,
  patch: Partial<Omit<PickupRule, "id" | "created_at">>,
): PickupRule | null {
  const existing = db()
    .prepare<[number], RuleRow>("SELECT * FROM pickup_rules WHERE id = ?")
    .get(id);
  if (!existing) return null;
  db()
    .prepare(
      `UPDATE pickup_rules SET enabled = ?, team_key = ?, label = ?, max_priority_num = ?, repo = ?, note = ?
       WHERE id = ?`,
    )
    .run(
      (patch.enabled ?? existing.enabled === 1) ? 1 : 0,
      patch.team_key !== undefined ? patch.team_key : existing.team_key,
      patch.label !== undefined ? patch.label : existing.label,
      patch.max_priority_num !== undefined ? patch.max_priority_num : existing.max_priority_num,
      patch.repo !== undefined ? patch.repo : existing.repo,
      patch.note !== undefined ? patch.note : existing.note,
      id,
    );
  return listRules().find((r) => r.id === id) ?? null;
}

export function deleteRule(id: number): boolean {
  return db().prepare("DELETE FROM pickup_rules WHERE id = ?").run(id).changes > 0;
}

// OR of ANDs: a ticket passes when any enabled rule matches all of its set
// fields. No rules at all = legacy behavior, everything passes.
export function matchesRules(issue: IssueSummary): boolean {
  const rules = listRules().filter((r) => r.enabled);
  if (rules.length === 0) return true;

  const teamKey = issue.identifier.split("-")[0] ?? "";
  const labels = issue.labels.map((l) => l.toLowerCase());
  const repo = inferRepo(issue);

  return rules.some((r) => {
    if (r.team_key && r.team_key.toLowerCase() !== teamKey.toLowerCase()) return false;
    if (r.label && !labels.includes(r.label.toLowerCase())) return false;
    if (r.max_priority_num != null) {
      // Linear: 0=None, 1=Urgent ... 4=Low. None never matches a priority rule.
      if (issue.priority === 0 || issue.priority > r.max_priority_num) return false;
    }
    if (r.repo && (repo ?? "").toLowerCase() !== r.repo.toLowerCase()) return false;
    return true;
  });
}
