// zcode-envelope.ts — pure reducer over zcode's ODW-protocol stdout.
// zcode-envelope.ts —— 对 zcode ODW-protocol stdout 的纯 reducer。
//
// In ODW-protocol mode (`ZCODE_ODW_PROTOCOL=1`) the zcode launcher runs the
// headless runtime and emits a SINGLE terminal JSON envelope on stdout:
// 在 ODW-protocol 模式（`ZCODE_ODW_PROTOCOL=1`）下，zcode launcher 以 headless
// 方式运行运行时，并在 stdout 上输出**单个**终止性 JSON 信封：
//
//   {"type":"zcode_result","text":"…","stderr":"…","exitCode":0,
//    "sessionId":null,"costUsd":null,"inputTokens":null,"outputTokens":null,
//    "telemetryAvailable":false}
//
// This is much simpler than claude stream-json or codex JSONL: there is no event
// folding — at most one envelope line, and everything else on stdout is runtime
// chatter that parseLine skips (returns null). No I/O, no subprocess; just parse
// + map. This mirrors codex-jsonl.ts in role, not in complexity.
// 这比 claude stream-json 或 codex JSONL 简单得多：没有事件折叠——至多一行
// 信封，stdout 上其余内容都是运行时杂音，parseLine 会跳过（返回 null）。
// 无 I/O、无子进程；只做解析 + 映射。它在角色上对应 codex-jsonl.ts，但复杂度更低。

/** The shape zcode's launcher prints in ODW-protocol mode. `ZCODE_NODE` is the */
/** zcode launcher 在 ODW-protocol 模式下打印的形状。`ZCODE_NODE` 是 */
/** node executable it was launched with; omitted here as unused. */
/** 启动它的 node 可执行文件；此处未用到故省略。 */
export interface ZcodeResultEnvelope {
  type: "zcode_result";
  text: string;
  stderr: string;
  exitCode: number;
  sessionId: string | null;
  /** USD cost; null until the runtime reports telemetry (currently always null). */
  /** USD 成本；在运行时报出遥测之前为 null（目前恒为 null）。 */
  costUsd: number | null;
  /** Input tokens; null when telemetry is unavailable. */
  /** 输入 token；遥测不可用时为 null。 */
  inputTokens: number | null;
  /** Output tokens; null when telemetry is unavailable. */
  /** 输出 token；遥测不可用时为 null。 */
  outputTokens: number | null;
  /** False until the runtime reports verified machine-readable telemetry. */
  /** 在运行时报出已验证的机器可读遥测之前为 false。 */
  telemetryAvailable: boolean;
}

/** Folded outcome of a zcode envelope. Mirrors CodexOutcome for symmetry. */
/** zcode 信封折叠后的结果。为对称起见，与 CodexOutcome 同构。 */
export interface ZcodeOutcome {
  text: string;
  structuredOutput?: unknown;
  sessionId: string | null;
  costUsd: number;
  resultSubtype: string;
  isError: boolean;
  usage: { inputTokens: number; outputTokens: number };
  telemetryAvailable: boolean;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function toFiniteNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Parse one stdout line into an envelope, or null to skip it. The launcher prints
 * exactly one `{"type":"zcode_result",…}` line; any other stdout (a stray banner,
 * a warning) is not JSON or not an envelope, and is skipped here. Never throws.
 *
 * 解析单行 stdout 为信封，或返回 null 表示跳过。launcher 恰好打印一行
 * `{"type":"zcode_result",…}`；stdout 上任何其它内容（散落的横幅、警告）要么
 * 不是 JSON、要么不是信封，在此被跳过。绝不抛异常。
 */
export function parseZcodeEnvelopeLine(line: string): ZcodeResultEnvelope | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (isObject(parsed) && parsed["type"] === "zcode_result") {
      return parsed as unknown as ZcodeResultEnvelope;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fold the parsed envelope(s) into a ZcodeOutcome. Defensive: tolerates a missing
 * envelope (no events), missing fields, and extra stdout chatter. The envelope's
 * `exitCode` is authoritative for isError (the launcher wraps the real child exit
 * code into it); the driver-supplied exitCode is ignored, mirroring how the claude
 * reducer trusts its terminal `result` event over the exit code.
 *
 * When `opts.schema` is set, `text` is JSON.parse'd into `structuredOutput`; a
 * parse failure flags `isError` (never throws) — matching the codex reducer.
 *
 * 把解析后的信封折叠成 ZcodeOutcome。做了防御性处理：容忍信封缺失（无事件）、
 * 字段缺失以及多余的 stdout 杂音。信封的 `exitCode` 对 isError 是权威的
 * （launcher 把真实子进程退出码包进了它）；driver 传入的 exitCode 被忽略，
 * 这与 claude reducer 信任其终止性 `result` 事件而非退出码的做法一致。
 *
 * 当 `opts.schema` 为真时，对 `text` 做 JSON.parse 得到 `structuredOutput`；
 * 解析失败标记 `isError`（绝不抛出）——与 codex reducer 一致。
 */
export function reduceZcodeEnvelope(
  events: unknown[],
  opts?: { schema?: boolean },
): ZcodeOutcome {
  // Find the last envelope line (there should be exactly one; "last" is defensive
  // against a runtime that ever prints more than one).
  // 找到最后一条信封行（应当恰好一条；取 "最后一条" 是对运行时偶发多条的防御）。
  let envelope: ZcodeResultEnvelope | undefined;
  for (const ev of events) {
    if (isObject(ev) && ev["type"] === "zcode_result") {
      envelope = ev as unknown as ZcodeResultEnvelope;
    }
  }

  // No envelope at all → the launcher failed before printing one. Treat as an
  // execution error with empty text (the driver's stderr fallback may fill text).
  // 完全没有信封 → launcher 在打印信封前就失败了。视为执行错误、text 为空
  // （driver 的 stderr 兜底可能会回填 text）。
  if (envelope === undefined) {
    return {
      text: "",
      sessionId: null,
      costUsd: 0,
      resultSubtype: "error_during_execution",
      isError: true,
      usage: { inputTokens: 0, outputTokens: 0 },
      telemetryAvailable: false,
    };
  }

  const isError = envelope.exitCode !== 0;
  const outcome: ZcodeOutcome = {
    text: envelope.text,
    sessionId: envelope.sessionId,
    costUsd: toFiniteNumber(envelope.costUsd),
    resultSubtype: isError ? "error_during_execution" : "success",
    isError,
    usage: {
      inputTokens: toFiniteNumber(envelope.inputTokens),
      outputTokens: toFiniteNumber(envelope.outputTokens),
    },
    telemetryAvailable: envelope.telemetryAvailable === true,
  };

  // When structured output is requested, parse the agent text as JSON. A parse
  // failure is an error (flag it, don't throw) — matches the codex reducer.
  // 请求结构化输出时，把 agent 文本当 JSON 解析。解析失败视为错误（标记，不抛）
  // ——与 codex reducer 一致。
  if (opts?.schema) {
    try {
      outcome.structuredOutput = JSON.parse(outcome.text);
    } catch {
      outcome.isError = true;
      outcome.resultSubtype = "error_during_execution";
    }
  }

  return outcome;
}
