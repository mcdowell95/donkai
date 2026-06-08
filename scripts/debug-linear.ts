import "dotenv/config";
import { LinearClient } from "@linear/sdk";

const client = new LinearClient({ apiKey: process.env.LINEAR_API_KEY! });

async function main() {
  const me = await client.viewer;
  console.log(`\n=== Viewer ===\nid:    ${me.id}\nemail: ${me.email}\nname:  ${me.name}\n`);

  const teamKeys = (process.env.LINEAR_TEAM_KEYS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  console.log(`Team keys requested: ${JSON.stringify(teamKeys)}\n`);

  const teams = await client.teams({ filter: { key: { in: teamKeys } } });
  console.log(`Teams matched: ${teams.nodes.length}`);
  for (const t of teams.nodes) console.log(`  ${t.key} → id=${t.id} name=${t.name}`);

  for (const t of teams.nodes) {
    const states = await client.workflowStates({ filter: { team: { id: { eq: t.id } } } });
    console.log(`\nStates on team ${t.key}:`);
    for (const s of states.nodes) console.log(`  "${s.name}" (type=${s.type})`);
  }

  console.log("\n=== All my open issues on these teams (no state filter) ===");
  const allMine = await client.issues({
    filter: {
      team: { id: { in: teams.nodes.map((t) => t.id) } },
      assignee: { id: { eq: me.id } },
      state: { type: { nin: ["completed", "canceled"] } },
    },
    first: 25,
  });
  for (const i of allMine.nodes) {
    const st = await i.state;
    console.log(`  ${i.identifier} [${st?.name}] ${i.title}`);
  }

  const stateReady = process.env.STATE_READY ?? "Ready for Claude";
  console.log(`\n=== Filter used by Donkai (state.name = "${stateReady}", assignee = me) ===`);
  const dQuery = await client.issues({
    filter: {
      team: { id: { in: teams.nodes.map((t) => t.id) } },
      state: { name: { eq: stateReady } },
      assignee: { id: { eq: me.id } },
    },
    first: 25,
  });
  console.log(`Matched: ${dQuery.nodes.length}`);
  for (const i of dQuery.nodes) console.log(`  ${i.identifier} ${i.title}`);

  console.log(`\n=== Same filter but without assignee ===`);
  const noAssignee = await client.issues({
    filter: {
      team: { id: { in: teams.nodes.map((t) => t.id) } },
      state: { name: { eq: stateReady } },
    },
    first: 25,
  });
  console.log(`Matched: ${noAssignee.nodes.length}`);
  for (const i of noAssignee.nodes) {
    const a = await i.assignee;
    console.log(`  ${i.identifier} assignee=${a?.id ?? "(unassigned)"} (${a?.name ?? "—"}) — ${i.title}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
