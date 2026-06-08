import { config } from "../config.js";

export type WorkerOutcome =
  | "done"
  | "blocked_local"
  | "blocked_linear"
  | "detached"
  | "error";

export function classifyOutput(output: string): WorkerOutcome {
  if (/\bDONE:/i.test(output)) return "done";
  if (/\bBLOCKED:/i.test(output)) {
    const reason = extractBlocked(output).toLowerCase();
    if (config.tier2Keywords.some((kw) => reason.includes(kw))) {
      return "blocked_linear";
    }
    return "blocked_local";
  }
  return "error";
}

export function extractBlocked(output: string): string {
  const idx = output.search(/BLOCKED:/i);
  if (idx < 0) return "Unknown";
  return output.slice(idx + "BLOCKED:".length).trim().slice(0, 1500);
}

export function extractDoneSummary(output: string): string {
  const match = output.match(/DONE:[ \t]*(.*)/i);
  return match?.[1]?.trim() ?? output.slice(0, 400);
}

export function extractPrUrls(output: string): string[] {
  const re = /https:\/\/github\.com\/[^\s)>\]]+\/pull\/\d+/g;
  return Array.from(new Set(output.match(re) ?? []));
}

export interface HarvestProposal {
  proposal: string;
  section: string;
}

export function parseHarvestProposal(output: string): HarvestProposal | null {
  const propMatch = output.match(/PROPOSAL:\s*([\s\S]*?)\s*SECTION:\s*(.+)/i);
  if (!propMatch) return null;
  return {
    proposal: propMatch[1]!.trim(),
    section: propMatch[2]!.trim().split("\n")[0]!.trim(),
  };
}
