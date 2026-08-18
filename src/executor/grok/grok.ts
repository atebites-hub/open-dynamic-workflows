// executor/grok/grok.ts — the only module that touches `grok`.
// executor/grok/grok.ts —— 唯一直接调用 `grok` 的模块。
//
// Spawns headless `grok -p` with machine-readable `--output-format` (streaming-json
// 启动 headless `grok -p`，使用机器可读的 `--output-format`（无 schema 时
// by default; json when `--json-schema` is set). Never emits `--tools` (known 0.2.x
// streaming-json；带 `--json-schema` 时为 json）。绝不输出 `--tools`（已知的
// session-creation bug). Child env strips this plugin's MCP so a nested grok cannot
// 0.2.x session-creation bug）。子进程环境剥掉本插件 MCP，避免嵌套 grok
// fork-bomb. CLI-neutral machinery lives in subprocess.ts.
// fork-bomb。与 CLI 无关的机制放在 subprocess.ts。

import type { ExecOptions, Executor } from "../../types.js";
import { parseGrokJsonLine, reduceGrokEvents } from "./grok-json.js";
import { type ExecResultCore, makeSubprocessExecutor } from "../subprocess.js";

const CHILD_UNSET = [
  "GROK_PLUGIN_ROOT",
  "GROK_PLUGIN_DATA",
  "CLAUDE_PLUGIN_ROOT",
  "CLAUDE_PLUGIN_DATA",
];

function resolveGrokBin(): string {
  return process.env.GROK_BIN?.trim() || "grok";
}

/**
 * Build argv for headless grok. Fixed base: `-p <prompt> --output-format … --always-approve
 * --sandbox workspace --no-auto-update --cwd <cwd>`. INVARIANT: never emits `--tools`.
 */
export function buildGrokArgs(opts: ExecOptions): string[] {
  const useSchema = opts.schema !== undefined;
  const args: string[] = [
    "-p",
    opts.prompt,
    "--output-format",
    useSchema ? "json" : "streaming-json",
    "--always-approve",
    "--sandbox",
    "workspace",
    "--no-auto-update",
    "--cwd",
    opts.cwd,
  ];
  if (opts.model) args.push("-m", opts.model);
  if (opts.reasoningEffort) args.push("--effort", opts.reasoningEffort);
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  if (useSchema) args.push("--json-schema", JSON.stringify(opts.schema));
  if (opts.appendSystemPrompt && opts.appendSystemPrompt.trim().length > 0) {
    args.push("--rules", opts.appendSystemPrompt.trim());
  }
  return args;
}

function reduceGrok(
  events: unknown[],
  ctx: { stderr: string; exitCode: number | null; opts: ExecOptions },
): ExecResultCore {
  const outcome = reduceGrokEvents(events, {
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

function makeGrokExecutor(): Executor {
  return makeSubprocessExecutor({
    command: resolveGrokBin(),
    prepare: async (opts) => ({
      args: buildGrokArgs(opts),
      env: {
        GROK_DISABLE_AUTOUPDATER: "1",
        ODW_GROK_LEAF: "1",
      },
      unsetEnv: CHILD_UNSET,
    }),
    parseLine: parseGrokJsonLine,
    reduce: (events, ctx) => reduceGrok(events, ctx),
  });
}

// Resolve GROK_BIN on each call so tests (and hosts) can override after import.
// 每次调用时解析 GROK_BIN，便于测试和 host 在 import 之后覆盖。
export const grokExecutor: Executor = (opts) => makeGrokExecutor()(opts);
