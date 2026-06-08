import "dotenv/config";
import { startOrchestrator } from "./loop.js";

startOrchestrator().catch((err) => {
  console.error("Fatal orchestrator error:", err);
  process.exit(1);
});
