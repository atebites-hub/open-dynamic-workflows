// zcode-envelope.test.ts — unit tests for the zcode ODW-protocol envelope reducer
// zcode-envelope.test.ts —— zcode ODW-protocol 信封 reducer 的单元测试
// (pure, no I/O). Fixtures use the REAL envelope shape the zcode launcher prints
// （纯函数，无 I/O）。各 fixture 采用 zcode launcher 真实打印的信封形状
// when `ZCODE_ODW_PROTOCOL=1`:
// （当 `ZCODE_ODW_PROTOCOL=1` 时）：
//   {"type":"zcode_result","text":"…","stderr":"…","exitCode":0,
//    "sessionId":null,"costUsd":null,"inputTokens":null,"outputTokens":null,
//    "telemetryAvailable":false}
//
// Run: npx tsx --test src/executor/zcode/zcode-envelope.test.ts
// 运行：npx tsx --test src/executor/zcode/zcode-envelope.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { reduceZcodeEnvelope, parseZcodeEnvelopeLine } from "./zcode-envelope.js";
import type { ZcodeResultEnvelope } from "./zcode-envelope.js";

// ────────────────────────────────────────────────────────────────────────────
// Fixture builders — emit the exact envelope shape the launcher writes, then
// fixture 构造器 —— 产出 launcher 真实写出的信封形状，再走一遍 JSON 往返，
// JSON round-trip each one so the reducer is fed exactly what
// 使得喂给 reducer 的，与 `parseZcodeEnvelopeLine` 从真实 stdout 解析出来的
// `parseZcodeEnvelopeLine` would yield from real stdout (no hand-built object
// 完全一致（不走手搓对象的捷径）。
// shortcuts).
// ────────────────────────────────────────────────────────────────────────────

/** Parse a list of raw lines into events, dropping blank/bad lines (null). */
/** 把一组原始行解析成事件，丢弃空行/坏行（null）。 */
function eventsFromLines(lines: string[]): unknown[] {
  const out: unknown[] = [];
  for (const line of lines) {
    const ev = parseZcodeEnvelopeLine(line);
    if (ev !== null) out.push(ev);
  }
  return out;
}

/** A real envelope line. Telemetry fields default to the launcher's current nulls. */
/** 一条真实信封行。遥测字段默认为 launcher 目前的 null 值。 */
function envelope(over: Partial<ZcodeResultEnvelope> = {}): string {
  return JSON.stringify({
    type: "zcode_result",
    text: "",
    stderr: "",
    exitCode: 0,
    sessionId: null,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    telemetryAvailable: false,
    ...over,
  } satisfies ZcodeResultEnvelope);
}

/** Non-envelope stdout chatter (a banner / warning) that must be skipped. */
/** 非信封的 stdout 杂音（横幅 / 警告），必须被跳过。 */
function chatter(line: string): string {
  return JSON.stringify({ type: "console.log", message: line });
}

// ────────────────────────────────────────────────────────────────────────────
// (1) happy path: envelope exitCode 0 → text extracted, isError=false
// (1) happy path：信封 exitCode 0 → 提取 text，isError=false
// ────────────────────────────────────────────────────────────────────────────

test("(1) happy path: exitCode 0 → text extracted, isError=false, subtype=success", () => {
  const events = eventsFromLines([
    envelope({ text: "hello", exitCode: 0 }),
  ]);

  const outcome = reduceZcodeEnvelope(events);

  assert.equal(outcome.text, "hello");
  assert.equal(outcome.isError, false);
  assert.equal(outcome.resultSubtype, "success");
  // Telemetry is null in the envelope → coerced to 0 (honest about the gap).
  // 信封里遥测为 null → 强转为 0（如实反映该缺口）。
  assert.equal(outcome.usage.inputTokens, 0);
  assert.equal(outcome.usage.outputTokens, 0);
  assert.equal(outcome.costUsd, 0);
  assert.equal(outcome.telemetryAvailable, false);
  assert.equal(outcome.sessionId, null);
  // No structured output requested → structuredOutput stays undefined.
  // 未请求结构化输出 → structuredOutput 保持 undefined。
  assert.equal(outcome.structuredOutput, undefined);
});

// ────────────────────────────────────────────────────────────────────────────
// (2) schema: envelope.text is a JSON string → structuredOutput parsed
// (2) schema：信封 text 是一段 JSON 字符串 → structuredOutput 被解析出来
// ────────────────────────────────────────────────────────────────────────────

test('(2) schema: text=\'{"ok":true}\' parses to structuredOutput {ok:true}', () => {
  const events = eventsFromLines([
    envelope({ text: '{"ok":true}', exitCode: 0 }),
  ]);

  const outcome = reduceZcodeEnvelope(events, { schema: true });

  assert.deepEqual(outcome.structuredOutput, { ok: true });
  // The raw JSON text is preserved on `text`; the run still succeeded.
  // 原始 JSON 文本保留在 `text` 上；run 仍判为成功。
  assert.equal(outcome.text, '{"ok":true}');
  assert.equal(outcome.isError, false);
  assert.equal(outcome.resultSubtype, "success");
});

// ────────────────────────────────────────────────────────────────────────────
// (3) schema parse failure → isError=true (never throws)
// (3) schema 解析失败 → isError=true（绝不抛出）
// ────────────────────────────────────────────────────────────────────────────

test("(3) schema: non-JSON text → parse failure flags isError, never throws", () => {
  const events = eventsFromLines([
    envelope({ text: "not json at all", exitCode: 0 }),
  ]);

  const outcome = reduceZcodeEnvelope(events, { schema: true });

  assert.equal(outcome.isError, true);
  assert.equal(outcome.resultSubtype, "error_during_execution");
  // structuredOutput stays undefined on parse failure (not set to a bad value).
  // 解析失败时 structuredOutput 保持 undefined（不会被设成脏值）。
  assert.equal(outcome.structuredOutput, undefined);
  // The un-parseable text is preserved for diagnostics.
  // 不可解析的文本仍被保留，便于排查。
  assert.equal(outcome.text, "not json at all");
});

// ────────────────────────────────────────────────────────────────────────────
// (3b) schema: JSON wrapped in prose / markdown fences still parses (Bug 1).
//      Models without a native --json-schema flag (zcode) often emit
//      "Here is the result:\n```json {...} ```" — a bare JSON.parse would throw
//      and waste the agent. The extractor recovers the {...} object.
// (3b) schema：被散文/markdown 围栏包裹的 JSON 仍可解析（Bug 1）。
//      没有原生 --json-schema flag 的 CLI（zcode）常常输出
//      "Here is the result:\n```json {...} ```" —— 裸 JSON.parse 会抛出、浪费整个 agent。
//      提取器把 {...} 对象恢复出来。
// ────────────────────────────────────────────────────────────────────────────

test("(3b) schema: prose + ```json fence around the object still parses", () => {
  const wrapped =
    'I have finished reading the file. Returning the review.\n' +
    '```json\n{"lens":"rendering","issues":[],"shipReady":true}\n' +
    "```\nLet me know if you need more.";
  const events = eventsFromLines([envelope({ text: wrapped, exitCode: 0 })]);

  const outcome = reduceZcodeEnvelope(events, { schema: true });

  assert.equal(outcome.isError, false);
  assert.equal(outcome.resultSubtype, "success");
  assert.deepEqual(outcome.structuredOutput, {
    lens: "rendering",
    issues: [],
    shipReady: true,
  });
  // The original (wrapped) text is preserved on `text` for diagnostics.
  // 原始（被包裹的）文本仍保留在 `text` 上，便于排查。
  assert.equal(outcome.text, wrapped);
});

// ────────────────────────────────────────────────────────────────────────────
// (4) non-zero exitCode → isError=true (envelope is authoritative)
// (4) 非零 exitCode → isError=true（信封是权威来源）
// ────────────────────────────────────────────────────────────────────────────

test("(4) non-zero exitCode → isError=true even with text present", () => {
  const events = eventsFromLines([
    envelope({ text: "partial answer", exitCode: 1 }),
  ]);

  const outcome = reduceZcodeEnvelope(events);

  assert.equal(outcome.isError, true);
  assert.equal(outcome.resultSubtype, "error_during_execution");
  // The agent text we did see is still preserved.
  // 已经看到的 agent 文本仍被保留。
  assert.equal(outcome.text, "partial answer");
  // Confirm exitCode 0 with the same text is success — the exit code decides.
  // 确认同样的 text 在 exitCode 0 下为成功——决定因素是退出码。
  const ok = reduceZcodeEnvelope(eventsFromLines([envelope({ text: "partial answer", exitCode: 0 })]));
  assert.equal(ok.isError, false);
  assert.equal(ok.resultSubtype, "success");
});

// ────────────────────────────────────────────────────────────────────────────
// (5) error with empty text + stderr → stderr surfaced as text
// (5) 出错且 text 为空 + 有 stderr → stderr 兜进 text
//     (mirrors claude/codex stderr fallback; here we assert the reducer preserves
//      (对应 claude/codex 的 stderr 兜底；此处断言 reducer 把信封里的
//      the envelope's stderr field so the adapter's fallback can surface it.)
//      stderr 字段保留下来，供 adapter 的兜底逻辑带出。)
// ────────────────────────────────────────────────────────────────────────────

test("(5) error + empty text → the reducer leaves text empty (adapter surfaces stderr)", () => {
  // The reducer itself does not move stderr into text (it has no stderr input);
  // the adapter's reduce wrapper does that fallback using the envelope's stderr,
  // mirroring claude.ts/codex.ts. Here we pin the reducer contract: on an error
  // with empty text, text stays empty so the adapter can detect the gap.
  // reducer 本身不会把 stderr 挪进 text（它没有 stderr 输入）；adapter 的 reduce
  // 包装才用信封里的 stderr 做那层兜底，与 claude.ts/codex.ts 一致。这里固定
  // reducer 的契约：出错且 text 为空时，text 保持空，以便 adapter 察觉缺口。
  const events = eventsFromLines([
    envelope({ text: "", stderr: "auth failed: invalid api key", exitCode: 1 }),
  ]);

  const outcome = reduceZcodeEnvelope(events);

  assert.equal(outcome.isError, true);
  assert.equal(outcome.text, "");
});

// ────────────────────────────────────────────────────────────────────────────
// (6) parseZcodeEnvelopeLine: blank / malformed / non-envelope lines → null
// (6) parseZcodeEnvelopeLine：空行 / 坏行 / 非信封行 → null
// ────────────────────────────────────────────────────────────────────────────

test("(6) parseZcodeEnvelopeLine returns null for blank / malformed / non-envelope lines", () => {
  // Blank and whitespace-only lines → null. ｜ 空行与纯空白行 → null。
  assert.equal(parseZcodeEnvelopeLine(""), null);
  assert.equal(parseZcodeEnvelopeLine("   "), null);
  assert.equal(parseZcodeEnvelopeLine("\t  \n"), null);

  // Non-JSON / truncated JSON → null (never throws). ｜ 非 JSON / 截断的 JSON → null（绝不抛）。
  assert.equal(parseZcodeEnvelopeLine("not json at all"), null);
  assert.equal(parseZcodeEnvelopeLine('{"type":"zcode_result"'), null);

  // Well-formed JSON but NOT an envelope → null (runtime chatter is skipped).
  // 格式良好的 JSON 但不是信封 → null（运行时杂音被跳过）。
  assert.equal(parseZcodeEnvelopeLine(chatter("spurious banner")), null);
  assert.equal(parseZcodeEnvelopeLine(JSON.stringify({ type: "other" })), null);

  // A real envelope line still parses to the expected object.
  // 真实的信封行仍解析为预期对象。
  const ev = parseZcodeEnvelopeLine(envelope({ text: "hi", exitCode: 0 }));
  assert.equal(ev?.type, "zcode_result");
  assert.equal(ev?.text, "hi");
  assert.equal(ev?.exitCode, 0);
});

// ────────────────────────────────────────────────────────────────────────────
// (7) no envelope at all → error outcome (defensive: launcher died before printing)
// (7) 完全没有信封 → 错误结果（防御性：launcher 在打印前就死了）
// ────────────────────────────────────────────────────────────────────────────

test("(7) no envelope in stdout → isError=true, empty text (launcher never printed one)", () => {
  // Only chatter, no envelope. ｜ 只有杂音，没有信封。
  const events = eventsFromLines([
    chatter("starting up"),
    chatter("warning: something"),
  ]);

  const outcome = reduceZcodeEnvelope(events);

  assert.equal(outcome.isError, true);
  assert.equal(outcome.resultSubtype, "error_during_execution");
  assert.equal(outcome.text, "");
  assert.equal(outcome.sessionId, null);
  assert.equal(outcome.telemetryAvailable, false);
});

// ────────────────────────────────────────────────────────────────────────────
// (8) telemetry: when the envelope reports real numbers, they round-trip
// (8) 遥测：当信封报出真实数值时，原样透传
// ────────────────────────────────────────────────────────────────────────────

test("(8) telemetry present → usage/cost/telemetryAvailable round-trip", () => {
  // Forward-looking: if a future launcher fills these in, the reducer honors them.
  // 面向未来：若日后的 launcher 填上这些字段，reducer 会如实采用。
  const events = eventsFromLines([
    envelope({
      text: "done",
      exitCode: 0,
      costUsd: 0.0123,
      inputTokens: 1500,
      outputTokens: 42,
      telemetryAvailable: true,
      sessionId: "sess_abc",
    }),
  ]);

  const outcome = reduceZcodeEnvelope(events);

  assert.equal(outcome.usage.inputTokens, 1500);
  assert.equal(outcome.usage.outputTokens, 42);
  assert.equal(outcome.costUsd, 0.0123);
  assert.equal(outcome.telemetryAvailable, true);
  assert.equal(outcome.sessionId, "sess_abc");
  assert.equal(outcome.isError, false);
});

// ────────────────────────────────────────────────────────────────────────────
// (8b) Bug 5: when the envelope carries only a total (no input/output split), the reducer
//      falls back to the total so tokensSpent is non-zero. The runtime footer's per-turn usage
//      is sometimes absent (depends on the model); the projection total is always present.
// (8b) Bug 5：当信封只带总数（无 input/output 拆分）时，reducer 回退到总数，使 tokensSpent 非零。
//      运行时尾行的单轮 usage 有时缺失（取决于模型）；projection 的总数始终存在。
// ────────────────────────────────────────────────────────────────────────────

test("(8b) Bug 5: totalTokens-only envelope falls back to the total for input/output", () => {
  const events = eventsFromLines([
    envelope({
      text: "done",
      exitCode: 0,
      totalTokens: 2000,
      telemetryAvailable: true,
      sessionId: "sess_t",
    }),
  ]);

  const outcome = reduceZcodeEnvelope(events);
  // No split provided → both fall back to the total (so the run reports non-zero spend).
  // 未提供拆分 → 两者都回退到总数（使 run 上报非零花销）。
  assert.equal(outcome.usage.inputTokens, 2000);
  assert.equal(outcome.usage.outputTokens, 2000);
  assert.equal(outcome.telemetryAvailable, true);
  assert.equal(outcome.sessionId, "sess_t");
});

test("(8c) Bug 5: explicit input/output split takes precedence over totalTokens", () => {
  const events = eventsFromLines([
    envelope({
      text: "done",
      exitCode: 0,
      inputTokens: 1800,
      outputTokens: 200,
      totalTokens: 2000,
      telemetryAvailable: true,
    }),
  ]);

  const outcome = reduceZcodeEnvelope(events);
  // Split is present → use it exactly; the total is ignored for usage mapping.
  // 拆分存在 → 精确使用它；总数在 usage 映射中被忽略。
  assert.equal(outcome.usage.inputTokens, 1800);
  assert.equal(outcome.usage.outputTokens, 200);
});
