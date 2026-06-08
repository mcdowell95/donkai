import { LinearClient } from "@linear/sdk";
import { config } from "../config.js";

let _client: LinearClient | null = null;

export function linear(): LinearClient {
  if (!_client) {
    _client = new LinearClient({ apiKey: config.linear.apiKey });
  }
  return _client;
}

let _viewerCache: { id: string; email: string | null; name: string } | null = null;

export async function viewer(): Promise<{ id: string; email: string | null; name: string }> {
  if (_viewerCache) return _viewerCache;
  const me = await linear().viewer;
  _viewerCache = { id: me.id, email: me.email ?? null, name: me.name };
  return _viewerCache;
}

let _teamIdsCache: string[] | null = null;

export async function teamIds(): Promise<string[]> {
  if (_teamIdsCache) return _teamIdsCache;
  const teams = await linear().teams({ filter: { key: { in: config.linear.teamKeys } } });
  const ids = teams.nodes.map((t) => t.id);
  if (ids.length === 0) {
    throw new Error(
      `No Linear teams matched keys [${config.linear.teamKeys.join(",")}] — check LINEAR_TEAM_KEYS`,
    );
  }
  _teamIdsCache = ids;
  return ids;
}

interface StateInfo {
  id: string;
  name: string;
  type: string;
}

const _stateCache: Map<string, StateInfo[]> = new Map();

export async function teamStates(teamId: string): Promise<StateInfo[]> {
  const cached = _stateCache.get(teamId);
  if (cached) return cached;
  const states = await linear().workflowStates({ filter: { team: { id: { eq: teamId } } } });
  const info = states.nodes.map((s) => ({ id: s.id, name: s.name, type: s.type }));
  _stateCache.set(teamId, info);
  return info;
}

export async function findStateId(teamId: string, name: string): Promise<string | null> {
  const states = await teamStates(teamId);
  const match = states.find((s) => s.name.toLowerCase() === name.toLowerCase());
  return match ? match.id : null;
}
