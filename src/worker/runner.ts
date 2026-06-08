import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { db, logEvent } from "../registry/db.js";
import { peekSignal } from "../ipc/signals.js";
import { classifyOutput, type WorkerOutcome } from "./parse.js";

export interface WorkerResult {
  sessionId: string | null;
  output: string;
  outcome: WorkerOutcome;
  detached: boolean;
}

export interface RunOptions {
  ticketKey: string;
  workspace: string;
  prompt: string;
  resumeSessionId?: string | null;
}

export async function runWorker(opts: RunOptions): Promise<WorkerResult> {
  const { ticketKey, workspace, prompt, resumeSessionId } = opts;
  mkdirSync(workspace, { recursive: true });
  const logPath = join(workspace, "cc.log");

  let sessionId: string | null = resumeSessionId ?? null;
  let finalResult = "";
  let detached = false;
  let aborted = false;
  const controller = new AbortController();

  const stamp = () => new Date().toISOString();
  appendFileSync(
    logPath,
    `\n--- ${stamp()} starting worker (resume=${resumeSessionId ?? "none"}) ---\n`,
  );
  logEvent(ticketKey, "worker_start", { resume: resumeSessionId });

  const watcher = setInterval(() => {
    try {
      if (peekSignal(ticketKey, "takeover")) {
        detached = true;
        aborted = true;
        controller.abort();
      }
    } catch {
      /* swallow */
    }
  }, 1000);

  const timeout = setTimeout(() => {
    if (!aborted) {
      appendFileSync(logPath, `[${stamp()}] timeout after ${config.workerTimeoutMs}ms\n`);
      controller.abort();
    }
  }, config.workerTimeoutMs);

  try {
    const iter = query({
      prompt,
      options: {
        cwd: workspace,
        resume: resumeSessionId ?? undefined,
        model: config.claudeModel,
        permissionMode: "default",
        abortController: controller,
      },
    });

    for await (const msg of iter) {
      appendFileSync(logPath, JSON.stringify(msg) + "\n");
      handleMessage(msg, (sid, txt, usage) => {
        if (sid) sessionId = sid;
        if (txt != null) finalResult = txt;
        if (usage) recordCost(ticketKey, sessionId, usage);
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendFileSync(logPath, `[${stamp()}] worker error: ${msg}\n`);
    if (!detached) {
      logEvent(ticketKey, "worker_error", { error: msg });
      return { sessionId, output: msg, outcome: "error", detached: false };
    }
  } finally {
    clearInterval(watcher);
    clearTimeout(timeout);
  }

  if (detached) {
    logEvent(ticketKey, "worker_detached");
    return {
      sessionId,
      output: "Detached for human takeover",
      outcome: "detached",
      detached: true,
    };
  }

  const outcome = classifyOutput(finalResult);
  logEvent(ticketKey, "worker_finish", { outcome });
  return { sessionId, output: finalResult || "No final result", outcome, detached: false };
}

interface UsageInfo {
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  total_cost_usd?: number;
}

function handleMessage(
  msg: SDKMessage,
  emit: (sessionId: string | null, result: string | null, usage: UsageInfo | null) => void,
): void {
  const anyMsg = msg as unknown as {
    type?: string;
    subtype?: string;
    session_id?: string;
    result?: string;
    is_error?: boolean;
    total_cost_usd?: number;
    usage?: Record<string, number>;
    message?: { model?: string; usage?: Record<string, number> };
  };

  if (anyMsg.type === "system" && anyMsg.subtype === "init") {
    emit(anyMsg.session_id ?? null, null, null);
    return;
  }

  if (anyMsg.type === "result") {
    const text = anyMsg.is_error
      ? `ERROR: ${anyMsg.result ?? "(no message)"}`
      : (anyMsg.result ?? "");
    const usage: UsageInfo = {
      input_tokens: anyMsg.usage?.input_tokens,
      output_tokens: anyMsg.usage?.output_tokens,
      cache_read_input_tokens: anyMsg.usage?.cache_read_input_tokens,
      cache_creation_input_tokens: anyMsg.usage?.cache_creation_input_tokens,
      total_cost_usd: anyMsg.total_cost_usd,
    };
    emit(anyMsg.session_id ?? null, text, usage);
    return;
  }

  if (anyMsg.type === "assistant" && anyMsg.message?.usage) {
    emit(null, null, {
      model: anyMsg.message.model,
      input_tokens: anyMsg.message.usage.input_tokens,
      output_tokens: anyMsg.message.usage.output_tokens,
      cache_read_input_tokens: anyMsg.message.usage.cache_read_input_tokens,
      cache_creation_input_tokens: anyMsg.message.usage.cache_creation_input_tokens,
    });
  }
}

function recordCost(
  ticketKey: string,
  sessionId: string | null,
  usage: UsageInfo,
): void {
  if (!usage.input_tokens && !usage.output_tokens && !usage.total_cost_usd) return;
  db()
    .prepare(
      `INSERT INTO costs (
         ticket_key, session_id, model,
         input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
         cost_usd, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ticketKey,
      sessionId,
      usage.model ?? null,
      usage.input_tokens ?? null,
      usage.output_tokens ?? null,
      usage.cache_read_input_tokens ?? null,
      usage.cache_creation_input_tokens ?? null,
      usage.total_cost_usd ?? null,
      new Date().toISOString(),
    );
}
