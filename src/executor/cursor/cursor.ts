// executor/cursor/cursor.ts — the only module that touches the Cursor Agent CLI.
// executor/cursor/cursor.ts —— 唯一直接调用 Cursor Agent CLI 的模块。
//
// Spawns headless Cursor CLI (`cursor-agent`, or Cursor's `agent`) with `-p` /
// `--print`, `--output-format json|stream-json`, `--force`, `--trust`,
// `--approve-mcps`, and `--workspace`. Binary resolution: CURSOR_BIN, then
// Cursor's `cursor-agent`, then Cursor's `agent` — never a Grok `agent`
// (Grok Build also ships `~/.grok/bin/agent`). Nested leaves set
// ODW_CURSOR_LEAF=1, drop plugin-root env, and never pass `--plugin-dir`
// (no fork-bomb). Do not pass `--sandbox`: Cursor's values are
// enabled|disabled (enabled denies network; disabled is the dangerously-open
// analog of grok `--sandbox workspace`). `--force` + `--trust` is the
// documented unattended combo.
//
// 启动 headless Cursor CLI：`-p` / `--print`、`--output-format json|stream-json`、
// `--force`、`--trust`、`--approve-mcps`、`--workspace`。解析顺序：CURSOR_BIN →
// Cursor 的 `cursor-agent` → Cursor 的 `agent`——绝不把 Grok 的 `agent` 当成 Cursor。
// 嵌套叶子设置 ODW_CURSOR_LEAF=1、剥掉 plugin-root env、绝不传 `--plugin-dir`。

import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";

import type { ExecOptions, Executor } from "../../types.js";
import { compactSchemaToJson } from "../../schema/validate.js";
import { parseCursorJsonLine, reduceCursorEvents } from "./cursor-json.js";
import { type ExecResultCore, makeSubprocessExecutor } from "../subprocess.js";

const CHILD_UNSET = [
  "CURSOR_PLUGIN_ROOT",
  "PLUGIN_ROOT",
  "GROK_PLUGIN_ROOT",
  "GROK_PLUGIN_DATA",
  "CLAUDE_PLUGIN_ROOT",
  "CLAUDE_PLUGIN_DATA",
  "ZCODE_PLUGIN_ROOT",
];

function isExecutableFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function* whichAllOnPath(name: string): Generator<string> {
  const path = process.env.PATH ?? "";
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (isExecutableFile(candidate)) yield candidate;
  }
}

function wellKnownLocalBin(name: string): string {
  return join(homedir(), ".local", "bin", name);
}

function pathLooksLikeGrok(bin: string): boolean {
  const normalized = bin.replace(/\\/g, "/");
  if (normalized.includes("/.grok/")) return true;
  try {
    const real = realpathSync(bin).replace(/\\/g, "/");
    if (real.includes("/.grok/")) return true;
  } catch {
    /* dangling symlink / unreadable — fall through to help fingerprint */
  }
  return false;
}

function readCliHelp(bin: string): string {
  try {
    const result = spawnSync(bin, ["--help"], {
      encoding: "utf8",
      timeout: 2500,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  } catch {
    return "";
  }
}

function helpLooksLikeGrok(help: string): boolean {
  if (help.includes("streaming-json")) return true;
  if (help.includes("--always-approve") && !help.includes("--approve-mcps")) return true;
  if (/Usage:\s*grok\b/i.test(help)) return true;
  return false;
}

function helpLooksLikeCursor(help: string): boolean {
  // `--approve-mcps` is Cursor-specific (Grok uses `--always-approve`).
  // Do not use \b before `--flag`: `-` is a non-word char, so \b--foo never matches.
  if (help.includes("--approve-mcps")) return true;
  if (help.includes("--trust") && (help.includes("--print") || /(^|\s)-p(\s|,|$)/.test(help))) {
    return true;
  }
  return false;
}

/**
 * True when `bin` is Cursor CLI, not Grok Build's colliding `agent`.
 * `cursor-agent` is uniquely Cursor. Bare `agent` is fail-closed: Grok install
 * paths and Grok `--help` are rejected; Cursor `--help` fingerprints are required.
 */
export function isCursorCliBinary(bin: string): boolean {
  if (!isExecutableFile(bin)) return false;
  const base = basename(bin);
  if (base === "cursor-agent" || base === "cursor-agent.exe") {
    return !pathLooksLikeGrok(bin);
  }
  if (pathLooksLikeGrok(bin)) return false;
  const help = readCliHelp(bin);
  if (helpLooksLikeGrok(help)) return false;
  return helpLooksLikeCursor(help);
}

let cachedResolveKey = "";
let cachedResolveBin = "";

function resolveCursorBinUncached(): string {
  const override = process.env.CURSOR_BIN?.trim();
  if (override) return override;

  for (const candidate of whichAllOnPath("cursor-agent")) {
    if (isCursorCliBinary(candidate)) return candidate;
  }

  const localCursorAgent = wellKnownLocalBin("cursor-agent");
  if (isCursorCliBinary(localCursorAgent)) return localCursorAgent;

  for (const candidate of whichAllOnPath("agent")) {
    if (isCursorCliBinary(candidate)) return candidate;
  }

  const localAgent = wellKnownLocalBin("agent");
  if (isCursorCliBinary(localAgent)) return localAgent;

  return "cursor-agent";
}

/**
 * Resolve CURSOR_BIN, then Cursor's `cursor-agent`, then Cursor's `agent`.
 * Never returns a Grok `agent`. Falls back to the name `cursor-agent` so spawn
 * fails with a clear ENOENT rather than silently driving Grok.
 */
export function resolveCursorBin(): string {
  const key = `${process.env.CURSOR_BIN ?? ""}\0${process.env.PATH ?? ""}\0${process.env.HOME ?? ""}`;
  if (key === cachedResolveKey) return cachedResolveBin;
  const resolved = resolveCursorBinUncached();
  cachedResolveKey = key;
  cachedResolveBin = resolved;
  return resolved;
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
 * `-p` + `--output-format json|stream-json` + `--force` + `--trust` +
 * `--approve-mcps` + `--workspace`. Never `--plugin-dir`. Never `--sandbox disabled`.
 */
export function buildCursorArgs(opts: ExecOptions): string[] {
  const args: string[] = [
    "-p",
    "--output-format",
    opts.schema !== undefined ? "json" : "stream-json",
    "--force",
    "--trust",
    "--approve-mcps",
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
