import { db } from "../registry/db.js";
import { config } from "../config.js";
import { runWorker } from "../worker/runner.js";
import { buildHarvestPrompt } from "../worker/prompts.js";
import { parseHarvestProposal } from "../worker/parse.js";

export async function harvestLearnings(
  ticketKey: string,
  sessionId: string,
  workspace: string,
): Promise<void> {
  const prompt = buildHarvestPrompt(ticketKey, config.workerClaudeMd);
  const result = await runWorker({
    ticketKey,
    workspace,
    prompt,
    resumeSessionId: sessionId,
  });

  const parsed = parseHarvestProposal(result.output);
  if (!parsed) return;

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
