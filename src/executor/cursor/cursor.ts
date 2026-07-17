// executor/cursor/cursor.ts — the only module that touches `cursor-agent`.
//
// Spawns `cursor-agent --print --output-format stream-json`, feeds the prompt as
// a trailing argv token, parses NDJSON line-by-line, and reduces to ExecResult.
// Shared machinery lives in subprocess.ts.
//
// Command is `cursor-agent` (not bare `agent`) so PATH collisions with Grok's
// `agent` shim cannot mis-route the call.
//
// INVARIANT: uses `--force` (allow tools unless denied) — never invents a
// "dangerously skip all permissions" flag.

import type { ExecOptions, Executor } from "../../types.js";
import { parseCursorStreamLine, reduceCursorStreamEvents } from "./stream-json.js";
import { type ExecResultCore, makeSubprocessExecutor } from "../subprocess.js";

/**
 * Build argv for Cursor Agent headless mode.
 *
 * Fixed base:
 *   --print
 *   --output-format stream-json
 *   --force                    (automation-friendly tool allow; not a full bypass)
 *   --workspace <opts.cwd>
 *
 * Optional: --model, --resume
 * Prompt is the final positional (Cursor has no --prompt-file; keep prompts under
 * OS argv limits or host-truncate). appendSystemPrompt is prepended to the prompt.
 * Schema is not a first-class Cursor flag — when present, the reducer JSON.parse's
 * the final text (and the host should ask for JSON in the prompt).
 */
export function buildCursorArgs(opts: ExecOptions): { args: string[]; prompt: string } {
  const args: string[] = [
    "--print",
    "--output-format",
    "stream-json",
    "--force",
    "--workspace",
    opts.cwd,
  ];
  if (opts.model) args.push("--model", opts.model);
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);

  let prompt = opts.prompt;
  if (opts.appendSystemPrompt) {
    prompt = `${opts.appendSystemPrompt}\n\n${opts.prompt}`;
  }
  if (opts.schema) {
    // Cursor has no --json-schema; instruct the model and parse in the reducer.
    prompt =
      `${prompt}\n\n` +
      `Respond with a single JSON object matching this JSON Schema (no markdown fences):\n` +
      `${JSON.stringify(opts.schema)}`;
  }

  args.push(prompt);
  return { args, prompt };
}

function reduceCursor(
  events: unknown[],
  ctx: { stderr: string; exitCode: number | null; opts: ExecOptions },
): ExecResultCore {
  const outcome = reduceCursorStreamEvents(events, {
    schema: ctx.opts.schema !== undefined,
    exitCode: ctx.exitCode,
  });

  const core: ExecResultCore = {
    text: outcome.text,
    sessionId: outcome.sessionId,
    costUsd: 0,
    resultSubtype: outcome.resultSubtype,
    isError: outcome.isError,
    usage: {
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
    },
  };
  if (outcome.structuredOutput !== undefined) {
    core.structuredOutput = outcome.structuredOutput;
  }

  if (core.isError && ctx.stderr.trim().length > 0 && core.text.length === 0) {
    core.text = ctx.stderr.trim();
  }

  return core;
}

export const cursorExecutor: Executor = makeSubprocessExecutor({
  command: "cursor-agent",
  prepare: async (opts) => {
    const { args } = buildCursorArgs(opts);
    return { args };
  },
  parseLine: parseCursorStreamLine,
  reduce: (events, { stderr, exitCode, opts }) =>
    reduceCursor(events, { stderr, exitCode, opts }),
});
