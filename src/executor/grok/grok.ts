// executor/grok/grok.ts — the only module that touches `grok`.
//
// Spawns `grok` headless (`--prompt-file` + `--output-format streaming-json`),
// parses streaming-json line-by-line, and reduces to ExecResult.
// Shared machinery (spawn / kill / watchdogs / line buffering / trace) lives in
// subprocess.ts.

import { randomBytes } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecOptions, Executor } from "../../types.js";
import { parseGrokStreamLine, reduceGrokStreamEvents } from "./streaming-json.js";
import { type ExecResultCore, makeSubprocessExecutor } from "../subprocess.js";

/**
 * Build argv for Grok Build headless mode.
 *
 * Fixed base:
 *   --output-format streaming-json
 *   --permission-mode acceptEdits   (never bypassPermissions)
 *   --cwd <opts.cwd>
 *   --prompt-file <path>            (avoids argv length limits; prompt on disk)
 *
 * Optional: -m, --json-schema, --rules (append system), --resume
 * INVARIANT: never emits --permission-mode bypassPermissions or --always-approve.
 */
export function buildGrokArgs(
  opts: ExecOptions,
  promptPath: string,
): string[] {
  const args: string[] = [
    "--output-format",
    "streaming-json",
    "--permission-mode",
    "acceptEdits",
    "--cwd",
    opts.cwd,
    "--prompt-file",
    promptPath,
  ];
  if (opts.model) args.push("-m", opts.model);
  if (opts.schema) args.push("--json-schema", JSON.stringify(opts.schema));
  if (opts.appendSystemPrompt) args.push("--rules", opts.appendSystemPrompt);
  // Resume is journal-level in ODW; CLI-level resume is optional for host use only.
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  return args;
}

function reduceGrok(
  events: unknown[],
  ctx: { stderr: string; exitCode: number | null; opts: ExecOptions },
): ExecResultCore {
  const outcome = reduceGrokStreamEvents(events, {
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

export const grokExecutor: Executor = makeSubprocessExecutor({
  command: "grok",
  prepare: async (opts) => {
    const promptPath = join(
      tmpdir(),
      `odw-grok-prompt-${randomBytes(8).toString("hex")}.txt`,
    );
    await writeFile(promptPath, opts.prompt, "utf8");
    return {
      args: buildGrokArgs(opts, promptPath),
      // Prompt is on disk via --prompt-file; no stdin body required.
      cleanup: () => unlink(promptPath).catch(() => {}),
    };
  },
  parseLine: parseGrokStreamLine,
  reduce: (events, { stderr, exitCode, opts }) =>
    reduceGrok(events, { stderr, exitCode, opts }),
});
