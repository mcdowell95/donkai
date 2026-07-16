import { db } from "../registry/db.js";
import { config } from "../config.js";
import { runWorker } from "../worker/runner.js";
import { buildHarvestPrompt } from "../worker/prompts.js";
import {
  parseHarvestProposal,
  parseInlineLearning,
  type HarvestProposal,
} from "../worker/parse.js";

export function storeLearning(ticketKey: string, parsed: HarvestProposal): void {
  db()
    .prepare(
      `INSERT INTO learnings_pending (ticket_key, proposal, status, created_at)
       VALUES (?, ?, 'pending', ?)`,
    )
    .run(
      ticketKey,
      JSON.stringify({ proposal: parsed.proposal, section: parsed.section }),
      new Date().toISOString(),
    );
}

// Piggyback mode: the LEARNING block rides along in the worker's DONE output —
// zero extra worker calls. Returns true when a learning was captured.
export function harvestFromOutput(ticketKey: string, output: string): boolean {
  if (config.harvest.mode === "off") return false;
  const parsed = parseInlineLearning(output);
  if (!parsed) return false;
  storeLearning(ticketKey, parsed);
  return true;
}

// Separate mode: legacy behavior, but on the (cheap) harvest model — a resume
// plus one paragraph does not need the main worker model.
export async function harvestLearnings(
  ticketKey: string,
  sessionId: string,
  workspace: string,
): Promise<void> {
  if (config.harvest.mode !== "separate") return;
  const prompt = buildHarvestPrompt(ticketKey, config.workerClaudeMd);
  const result = await runWorker({
    ticketKey,
    workspace,
    prompt,
    resumeSessionId: sessionId,
    model: config.harvest.model,
  });

  const parsed = parseHarvestProposal(result.output);
  if (!parsed) return;
  storeLearning(ticketKey, parsed);
}
