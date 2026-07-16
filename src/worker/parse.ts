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

// Pulls the markdown block sitting under a `LABEL:` header in worker output.
// Block ends at the next ALL-CAPS label of the form `WORD:` on a new line, or
// at end of input. Returns null if the label is absent or the block is empty.
export function extractLabeledBlock(
  output: string,
  label: string,
): string | null {
  const headerRe = new RegExp(`(?:^|\\n)${label}:[ \\t]*\\n?`, "i");
  const headerMatch = output.match(headerRe);
  if (!headerMatch || headerMatch.index === undefined) return null;
  const afterLabel = output.slice(headerMatch.index + headerMatch[0].length);
  const nextLabelIdx = afterLabel.search(/\n[A-Z][A-Z_]+:/);
  const body =
    nextLabelIdx < 0 ? afterLabel : afterLabel.slice(0, nextLabelIdx);
  const trimmed = body.trim();
  return trimmed.length ? trimmed : null;
}

export function extractTestingSteps(output: string): string | null {
  return extractLabeledBlock(output, "TESTING");
}

export function extractReleaseNotes(output: string): string | null {
  return extractLabeledBlock(output, "RELEASE_NOTES");
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

// Piggyback harvest: `LEARNING: <line>` (+ optional `SECTION: <name>`) emitted
// inline with DONE — no separate harvest worker run needed.
export function parseInlineLearning(output: string): HarvestProposal | null {
  const learning = extractLabeledBlock(output, "LEARNING");
  if (!learning) return null;
  const section = output.match(/(?:^|\n)SECTION:[ \t]*(.+)/i)?.[1]?.trim();
  return { proposal: learning, section: section || "General" };
}
