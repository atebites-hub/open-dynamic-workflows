// executor/zcode/zcode.ts — the only module that touches `zcode`.
// executor/zcode/zcode.ts —— 唯一直接调用 `zcode` 的模块。
//
// Spawns `zcode --prompt <text> --mode yolo` under `ZCODE_ODW_PROTOCOL=1`, which
// makes the zcode launcher run the headless runtime and print a single
// 在 `ZCODE_ODW_PROTOCOL=1` 下启动 `zcode --prompt <text> --mode yolo`，这会让
// `{"type":"zcode_result",…}` envelope on stdout. The CLI-neutral machinery
// zcode launcher 以 headless 方式运行运行时，并在 stdout 打印单个
// (spawn / process-group kill / wall+idle+abort watchdogs / line buffering /
// `{"type":"zcode_result",…}` 信封。与 CLI 无关的机制（spawn / 进程组 kill /
// trace) lives in subprocess.ts; this module only injects what is specific to
// wall+idle+abort 看门狗 / 行缓冲 / trace）放在 subprocess.ts；本模块只注入
// `zcode`.
// 与 `zcode` 相关的部分。
//
// Differences from claude/codex, and how this adapter bridges them:
// 与 claude/codex 的差异，以及本适配器如何弥合：
//  - zcode takes the prompt via `--prompt <text>` only; it does NOT read stdin.
//    - zcode 只通过 `--prompt <text>` 接收 prompt；它不读 stdin。
//    (claude/codex feed stdin to dodge argv length limits; zcode gives us no
//    （claude/codex 用 stdin 来规避 argv 长度上限；zcode 没有这个选项，
//    choice, so the prompt goes on argv. Workflow prompts are normally far under
//    所以 prompt 走 argv。workflow 的 prompt 通常远低于
//    the OS argv ceiling of ~256KB.)
//    OS 约 256KB 的 argv 上限。）
//  - zcode has no `--json-schema` / `--output-schema` flag for structured output.
//    - zcode 没有 `--json-schema` / `--output-schema` 来强制结构化输出。
//    So when opts.schema is set, we INJECT a JSON instruction into the prompt and
//    因此当 opts.schema 存在时，我们把 JSON 指令注入 prompt，由 reducer 把
//    the reducer JSON.parse's the response (a parse failure flags isError).
//    响应做 JSON.parse（解析失败标记 isError）。
//  - zcode has no `--append-system-prompt` / `-c developer_instructions=` flag.
//    - zcode 没有 `--append-system-prompt` / `-c developer_instructions=` flag。
//    So opts.appendSystemPrompt (e.g. the agentType Explore/Plan preset) is
//    因此 opts.appendSystemPrompt（如 agentType 的 Explore/Plan 预设）被
//    prepended to the prompt as a bracketed instruction.
//    作为方括号指令前置于 prompt。
//  - zcode's headless permission mode is `--mode yolo` (the documented default
//    - zcode 的 headless 权限模式是 `--mode yolo`（`--prompt` 的文档默认值；
//    for `--prompt`; the build/edit/plan modes would block on approval prompts a
//    build/edit/plan 模式会卡在权限批准弹窗上，headless 无法响应）。这是 claude
//    headless run can't answer). This is the zcode counterpart of claude's
//    `--permission-mode acceptEdits`（不变量 #8）和 codex 的
//    `--permission-mode acceptEdits` (INVARIANT #8) and codex's
//    `--sandbox workspace-write`（不变量 #11）的 zcode 对应物（不变量 #12）。
//    `--sandbox workspace-write` (INVARIANT #11) — see INVARIANT #12.
//    zcode has NO `--dangerously-*` flag to avoid, so there is nothing to forbid.

import type { ExecOptions, Executor } from "../../types.js";
import { parseZcodeEnvelopeLine, reduceZcodeEnvelope } from "./zcode-envelope.js";
import { type ExecResultCore, makeSubprocessExecutor } from "../subprocess.js";

/**
 * The zcode executable. Resolved once at module load. `ZCODE_BIN` lets a host pin
 * an explicit path (e.g. a dev build) independent of PATH resolution — useful when
 * a global install would otherwise shadow a local checkout. Falls back to the bare
 * name `zcode` so PATH lookup applies, matching how the claude/codex adapters name
 * their CLIs.
 *
 * zcode 可执行文件。在模块加载时解析一次。`ZCODE_BIN` 允许 host 钉死一个显式
 * 路径（如 dev 构建），独立于 PATH 解析——在全局安装会遮蔽本地 checkout 时很有用。
 * 回退到裸名 `zcode` 以走 PATH 查找，与 claude/codex 适配器命名各自 CLI 的方式一致。
 */
const ZCODE_BIN = process.env.ZCODE_BIN?.trim() || "zcode";

/**
 * Fold an injected system-prompt / schema directive into the user prompt. zcode
 * has no separate flags for these, so they ride in the prompt text itself. The
 * schema directive asks for STRICT JSON only — the reducer then JSON.parse's it.
 *
 * 把注入的 system-prompt / schema 指令折叠进用户 prompt。zcode 没有独立的
 * flag 承载这些，所以它们随 prompt 文本一起传入。schema 指令要求只输出严格 JSON
 * ——之后 reducer 对其做 JSON.parse。
 */
function composePrompt(opts: ExecOptions): string {
  const parts: string[] = [];
  if (opts.appendSystemPrompt && opts.appendSystemPrompt.trim().length > 0) {
    parts.push(`[system instructions: ${opts.appendSystemPrompt.trim()}]`);
  }
  if (opts.schema !== undefined) {
    // Instruct strict JSON. The reducer JSON.parse's the envelope text; the runtime
    // (hooks.ts) re-validates against the schema, so a malformed object still fails.
    // 要求严格 JSON。reducer 会对信封 text 做 JSON.parse；运行时（hooks.ts）会
    // 再次按 schema 校验，因此畸形对象仍会失败。
    parts.push(
      `Respond with ONLY valid JSON (no prose, no code fences) matching this JSON Schema:\n${JSON.stringify(opts.schema)}`,
    );
  }
  parts.push(opts.prompt);
  return parts.join("\n\n");
}

/**
 * Build the argv for `zcode` from ExecOptions. The fixed base is
 * `--prompt <text> --mode yolo`: `--prompt` runs a single headless turn;
 * `--mode yolo` is the documented default for `--prompt` and the only mode that
 * doesn't block on approval prompts a headless run can't answer (INVARIANT #12).
 * `--model` is included only when explicitly provided (otherwise zcode uses its
 * configured default). zcode has no `--dangerously-*` flag, so — unlike claude's
 * `--dangerously-skip-permissions` or codex's
 * `--dangerously-bypass-approvals-and-sandbox` — there is nothing to forbid here.
 *
 * 根据 ExecOptions 构造 `zcode` 的 argv。固定基底是 `--prompt <text> --mode yolo`：
 * `--prompt` 跑单个 headless turn；`--mode yolo` 是 `--prompt` 的文档默认值，也是
 * 唯一不会卡在 headless 无法响应的批准弹窗上的模式（不变量 #12）。仅当显式提供时
 * 才带 `--model`（否则 zcode 用其配置的默认值）。zcode 没有 `--dangerously-*` flag，
 * 因此——不像 claude 的 `--dangerously-skip-permissions` 或 codex 的
 * `--dangerously-bypass-approvals-and-sandbox`——这里没有任何需要禁止的东西。
 */
export function buildZcodeArgs(opts: ExecOptions): string[] {
  const args: string[] = [
    "--prompt",
    composePrompt(opts),
    "--mode",
    "yolo",
  ];
  if (opts.model) args.push("--model", opts.model);
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  return args;
}

/**
 * Fold the parsed zcode envelope into an ExecResultCore. zcode reports no USD and
 * no token telemetry yet (the envelope's costUsd/inputTokens/outputTokens are
 * null, telemetryAvailable false); the reducer coerces nulls to 0 and passes
 * telemetryAvailable through verbatim, so a future launcher that fills these in
 * is honored with no adapter change. exitCode is authoritative for isError
 * (the launcher wraps the real child exit code into the envelope). The stderr
 * fallback mirrors claude.ts/codex.ts: on an error with no text, surface trimmed
 * stderr so the failure is debuggable.
 *
 * 把解析后的 zcode 信封折叠成 ExecResultCore。zcode 目前不报 USD，也不报 token
 * 遥测（信封的 costUsd/inputTokens/outputTokens 为 null，telemetryAvailable 为
 * false）；reducer 把 null 强转为 0 并原样透传 telemetryAvailable，因此日后
 * launcher 填上这些字段时无需改适配器即可生效。exitCode 对 isError 是权威的
 * （launcher 把真实子进程退出码包进了信封）。stderr 兜底与 claude.ts/codex.ts
 * 一致：出错且无 text 时，带出 trim 后的 stderr，便于排查。
 */
function reduceZcode(
  events: unknown[],
  ctx: { stderr: string; exitCode: number | null; opts: ExecOptions },
): ExecResultCore {
  const outcome = reduceZcodeEnvelope(events as any[], {
    schema: ctx.opts.schema !== undefined,
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
    ...(outcome.telemetryAvailable ? { telemetryAvailable: true } : {}),
  };
  if (outcome.structuredOutput !== undefined) {
    core.structuredOutput = outcome.structuredOutput;
  }

  // Surface stderr as a last resort when the turn errored with no usable text —
  // e.g. an auth/config failure that kills zcode before it prints an envelope,
  // leaving the reason only on stderr. Mirrors the claude/codex executors.
  // 当 turn 出错且没有可用 text 时（例如认证/配置错误导致 zcode 在打印信封前就死，
  // 原因只留在 stderr），把 stderr 兜出来作为最后手段。与 claude/codex 执行器一致。
  if (core.isError && ctx.stderr.trim().length > 0 && core.text.length === 0) {
    core.text = ctx.stderr.trim();
  }

  return core;
}

export const zcodeExecutor: Executor = makeSubprocessExecutor({
  command: ZCODE_BIN,
  // prepare() is sync here but the signature is async (the driver awaits it).
  // No temp files needed (zcode has no --output-schema file argument) and no stdin
  // (zcode doesn't read stdin), so this just returns argv + the protocol env var.
  // prepare() 此处是同步的，但签名是 async（driver 会 await 它）。无需临时文件
  //（zcode 没有 --output-schema 文件参数），也无需 stdin（zcode 不读 stdin），
  // 因此这里只返回 argv + protocol 环境变量。
  prepare: async (opts) => ({
    args: buildZcodeArgs(opts),
    env: { ZCODE_ODW_PROTOCOL: "1" },
  }),
  parseLine: parseZcodeEnvelopeLine,
  reduce: (events, { stderr, exitCode, opts }) =>
    reduceZcode(events, { stderr, exitCode, opts }),
});
