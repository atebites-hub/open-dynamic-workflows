// executor/cursor/cursor.ts — the only module that touches the Cursor Agent CLI.
//
// Spawns headless `cursor-agent` (or `agent`) `-p` / `--print` with
// `--output-format json|stream-json` and `--force` (alias `--yolo`). Prefer
// `cursor-agent` on PATH: a bare `agent` may be a different product (Grok).
// Nested leaves set ODW_CURSOR_LEAF=1 and drop plugin-root env (no fork-bomb).

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

import type { ExecOptions, Executor } from "../../types.js";
import { compactSchemaToJson } from "../../schema/validate.js";
import { parseCursorJsonLine, reduceCursorEvents } from "./cursor-json.js";
import { type ExecResultCore, makeSubprocessExecutor } from "../subprocess.js";

const CHILD_UNSET = [
  "CURSOR_PLUGIN_ROOT",
  "PLUGIN_ROOT",
  "GROK_PLUGIN_ROOT",
  "CLAUDE_PLUGIN_ROOT",
  "ZCODE_PLUGIN_ROOT",
];

function whichOnPath(name: string): string | undefined {
  const path = process.env.PATH ?? "";
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Resolve CURSOR_BIN, then cursor-agent, then agent. Prefer cursor-agent. */
export function resolveCursorBin(): string {
  const override = process.env.CURSOR_BIN?.trim();
  if (override) return override;
  return whichOnPath("cursor-agent") ?? whichOnPath("agent") ?? "cursor-agent";
}

function composePrompt(opts: ExecOptions): string {
  const parts: string[] = [];
  if (opts.appendSystemPrompt && opts.appendSystemPrompt.trim().length > 0) {
    parts.push(`[system instructions: ${opts.appendSystemPrompt.trim()}]`);
  }
  if (opts.schema !== undefined) {
    parts.push(
      `Respond with ONLY valid JSON (no prose, no code fences) matching this JSON Schema:\n${compactSchemaToJson(opts.schema)}`,
    );
  }
  parts.push(opts.prompt);
  return parts.join("\n\n");
}

/**
 * Build argv for headless Cursor Agent CLI.
 * `-p`/`--print` + `--output-format json|stream-json` + `--force` + prompt last.
 */
export function buildCursorArgs(opts: ExecOptions): string[] {
  const args: string[] = [
    "-p",
    "--output-format",
    opts.schema !== undefined ? "json" : "stream-json",
    "--force",
    "--workspace",
    opts.cwd,
  ];
  if (opts.model) args.push("--model", opts.model);
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  args.push(composePrompt(opts));
  return args;
}

function reduceCursor(
  events: unknown[],
  ctx: { stderr: string; exitCode: number | null; opts: ExecOptions },
): ExecResultCore {
  const outcome = reduceCursorEvents(events, {
    schema: ctx.opts.schema !== undefined,
    exitCode: ctx.exitCode,
  });
  const core: ExecResultCore = {
    text: outcome.text,
    sessionId: outcome.sessionId,
    costUsd: outcome.costUsd,
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

function makeCursorExecutor(): Executor {
  return makeSubprocessExecutor({
    command: resolveCursorBin(),
    prepare: async (opts) => ({
      args: buildCursorArgs(opts),
      env: { ODW_CURSOR_LEAF: "1" },
      unsetEnv: CHILD_UNSET,
    }),
    parseLine: parseCursorJsonLine,
    reduce: (events, ctx) => reduceCursor(events, ctx),
  });
}

export const cursorExecutor: Executor = (opts) => makeCursorExecutor()(opts);
