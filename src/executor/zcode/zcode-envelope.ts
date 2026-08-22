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

import { extractJsonObject } from "../../schema/extract-json.js";
import type { RoutingPolicy } from "../../types.js";
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
  /** Total tokens (input+output+reasoning); null when the runtime reports no total. Bug 5. */
  /** 总 token（input+output+reasoning）；运行时未报出总数时为 null。Bug 5。 */
  totalTokens: number | null;
  /** False until the runtime reports verified machine-readable telemetry. */
  /** 在运行时报出已验证的机器可读遥测之前为 false。 */
  telemetryAvailable: boolean;
  runtimeAttestation?: ZcodeRuntimeAttestation;
}

export interface ZcodeRuntimeAttestation {
  type: "zcode_runtime_attestation";
  schemaVersion: 1;
  executor: "zcode";
  route: "odw";
  runtimeId: string;
  runtimeVersion: string;
  sessionId: string;
  role: "main";
  parentSessionId: null;
  policySource: null;
  rolePolicy: null;
  rolePolicyFingerprint: null;
  model: string;
  reasoningEffort: string;
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
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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
  opts?: {
    schema?: boolean;
    effectiveRoute?: Readonly<RoutingPolicy>;
    routingPolicyFingerprint?: string;
  },
): ZcodeOutcome {
  // Find the last envelope line (there should be exactly one; "last" is defensive
  // against a runtime that ever prints more than one).
  // 找到最后一条信封行（应当恰好一条；取 "最后一条" 是对运行时偶发多条的防御）。
  const envelopes = events.filter((ev): ev is ZcodeResultEnvelope => isObject(ev) && ev["type"] === "zcode_result");
  const envelope = envelopes.at(-1);

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

  const invalidAttestation = (reason: string): ZcodeOutcome => ({
    text: `invalid zcode runtime attestation: ${reason}`,
    sessionId: envelope.sessionId ?? null,
    costUsd: toFiniteNumber(envelope.costUsd),
    resultSubtype: "error_during_execution",
    isError: true,
    usage: { inputTokens: 0, outputTokens: 0 },
    telemetryAvailable: false,
  });
  if (opts?.effectiveRoute !== undefined) {
    if (envelopes.length !== 1) return invalidAttestation("expected exactly one result envelope");
    const attestation = envelope.runtimeAttestation;
    if (!isObject(attestation)) return invalidAttestation("missing runtime attestation");
    if (attestation.type !== "zcode_runtime_attestation" || attestation.schemaVersion !== 1
      || attestation.executor !== "zcode" || attestation.route !== "odw"
      || attestation.role !== "main" || attestation.parentSessionId !== null
      || attestation.policySource !== null || attestation.rolePolicy !== null
      || attestation.rolePolicyFingerprint !== null
      || !isNonEmptyString(attestation.runtimeVersion)) {
      return invalidAttestation("malformed runtime attestation");
    }
    if (attestation.runtimeVersion === "unknown") return invalidAttestation("fallback runtime version");
    if (!isNonEmptyString(attestation.runtimeId) || !isNonEmptyString(attestation.sessionId)
      || attestation.runtimeId !== attestation.sessionId || attestation.runtimeId !== envelope.sessionId) {
      return invalidAttestation("runtime id mismatch");
    }
    if (opts.effectiveRoute.executor !== "zcode") return invalidAttestation("executor mismatch");
    if (attestation.model !== opts.effectiveRoute.model || attestation.reasoningEffort !== opts.effectiveRoute.reasoningEffort) {
      return invalidAttestation("observed route mismatch");
    }
    if (!/^[a-f0-9]{64}$/u.test(opts.routingPolicyFingerprint ?? "")) {
      return invalidAttestation("invalid policy fingerprint");
    }
  }

  const isError = envelope.exitCode !== 0;
  // Bug 5: map telemetry onto usage. The runtime footer (parsed by the launcher into the envelope)
  // may carry input/output split OR only a total. The run's tokensSpent tracks outputTokens, so
  // when the split is missing but a total is present, fall back to the total for outputTokens —
  // better a non-zero, slightly-overestimated spend than a silent 0. inputTokens falls back
  // symmetrically so the reported usage stays internally consistent.
  // Bug 5：把遥测映射到 usage。运行时尾行（由 launcher 解析进信封）可能带 input/output 拆分，
  // 也可能只带总数。run 的 tokensSpent 跟踪 outputTokens，故当拆分缺失但总数存在时，outputTokens
  // 回退为总数——宁可花销非零且略微高估，也不要静默的 0。inputTokens 对称回退，使上报的用法
  // 内部自洽。
  const total = toFiniteNumber(envelope.totalTokens);
  const outputTokens =
    envelope.outputTokens !== null && Number.isFinite(envelope.outputTokens)
      ? envelope.outputTokens
      : total;
  const inputTokens =
    envelope.inputTokens !== null && Number.isFinite(envelope.inputTokens)
      ? envelope.inputTokens
      : total;
  const outcome: ZcodeOutcome = {
    text: envelope.text,
    sessionId: envelope.sessionId,
    costUsd: toFiniteNumber(envelope.costUsd),
    resultSubtype: isError ? "error_during_execution" : "success",
    isError,
    usage: { inputTokens, outputTokens },
    telemetryAvailable: envelope.telemetryAvailable === true,
  };

  // When structured output is requested, parse the agent text as JSON. Models often wrap the
  // JSON in prose or markdown fences, so extract the first balanced {...} object before parsing
  // (a bare JSON.parse would throw on "Here is the result: {…}"). A parse failure is still an
  // error (flag it, don't throw) — matches the codex reducer.
  // 请求结构化输出时，把 agent 文本当 JSON 解析。模型常常把 JSON 包在散文或 markdown 围栏里，
  // 因此解析前先提取第一个平衡的 {...} 对象（裸 JSON.parse 在 "Here is the result: {…}" 上会抛）。
  // 解析失败仍视为错误（标记，不抛）——与 codex reducer 一致。
  if (opts?.schema) {
    const candidate = extractJsonObject(outcome.text) ?? outcome.text;
    try {
      outcome.structuredOutput = JSON.parse(candidate);
    } catch {
      outcome.isError = true;
      outcome.resultSubtype = "error_during_execution";
    }
  }

  return outcome;
}
