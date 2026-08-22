// grok-json.ts — pure reducers over grok headless stdout.
// grok-json.ts —— 对 grok headless stdout 的纯 reducer。
//
// Two documented machine-readable formats (user-guide/14-headless-mode.md):
// 两种文档化的机器可读格式：
//   --output-format json            → one object { text, stopReason, sessionId, … }
//                                     or { type:"error", message }
//   --output-format streaming-json  → NDJSON type-tagged events; `end` is last
//
// No I/O, no subprocess; parse + fold only. Schema requests JSON.parse the text
// (models may wrap JSON in prose; extractJsonObject first).

import { extractJsonObject } from "../../schema/extract-json.js";

export interface GrokOutcome {
  text: string;
  structuredOutput?: unknown;
  sessionId: string | null;
  costUsd: number;
  resultSubtype: string;
  isError: boolean;
  usage: { inputTokens: number; outputTokens: number };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function toFiniteNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function usageFrom(raw: unknown): { inputTokens: number; outputTokens: number } {
  if (!isObject(raw)) return { inputTokens: 0, outputTokens: 0 };
  return {
    inputTokens: toFiniteNumber(raw["input_tokens"] ?? raw["inputTokens"]),
    outputTokens: toFiniteNumber(raw["output_tokens"] ?? raw["outputTokens"]),
  };
}

function costFrom(raw: Record<string, unknown>): number {
  return toFiniteNumber(raw["total_cost_usd"] ?? raw["totalCostUsd"] ?? raw["costUsd"]);
}

function subtypeFor(isError: boolean, stopReason: string): string {
  if (!isError) return "success";
  if (stopReason === "max_turn_requests" || stopReason === "max_turns") {
    return "error_max_turns";
  }
  return "error_during_execution";
}

function applySchema(outcome: GrokOutcome, schema?: boolean): GrokOutcome {
  if (!schema || outcome.isError) return outcome;
  const candidate = extractJsonObject(outcome.text) ?? outcome.text;
  try {
    outcome.structuredOutput = JSON.parse(candidate);
  } catch {
    outcome.isError = true;
    outcome.resultSubtype = "error_during_execution";
  }
  return outcome;
}

/**
 * Parse one stdout line into an event object, or null to skip chatter.
 * 解析单行 stdout 为事件对象，或返回 null 以跳过杂音。
 */
export function parseGrokJsonLine(line: string): unknown | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function looksStreaming(events: unknown[]): boolean {
  for (const ev of events) {
    if (!isObject(ev)) continue;
    const type = ev["type"];
    if (
      type === "text" ||
      type === "thought" ||
      type === "tool_call" ||
      type === "tool_call_update" ||
      type === "usage" ||
      type === "plan" ||
      type === "end" ||
      type === "available_commands"
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Fold `--output-format json` objects. Success objects have no `type`; failures
 * are `{ type: "error", message }`.
 */
export function reduceGrokJson(
  events: unknown[],
  opts?: { schema?: boolean; exitCode?: number | null },
): GrokOutcome {
  let last: Record<string, unknown> | undefined;
  for (const ev of events) {
    if (isObject(ev)) last = ev;
  }

  if (last === undefined) {
    return {
      text: "",
      sessionId: null,
      costUsd: 0,
      resultSubtype: "error_during_execution",
      isError: true,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  if (last["type"] === "error") {
    const message = typeof last["message"] === "string" ? last["message"] : "grok error";
    return {
      text: message,
      sessionId: typeof last["sessionId"] === "string" ? last["sessionId"] : null,
      costUsd: costFrom(last),
      resultSubtype: "error_during_execution",
      isError: true,
      usage: usageFrom(last["usage"]),
    };
  }

  const text = typeof last["text"] === "string" ? last["text"] : "";
  const stopReason = typeof last["stopReason"] === "string" ? last["stopReason"] : "";
  const isError =
    stopReason === "refusal" ||
    stopReason === "cancelled" ||
    (opts?.exitCode !== undefined && opts.exitCode !== null && opts.exitCode !== 0);

  const outcome: GrokOutcome = {
    text,
    sessionId: typeof last["sessionId"] === "string" ? last["sessionId"] : null,
    costUsd: costFrom(last),
    resultSubtype: subtypeFor(isError, stopReason),
    isError,
    usage: usageFrom(last["usage"]),
  };
  return applySchema(outcome, opts?.schema);
}

/**
 * Fold `--output-format streaming-json` NDJSON. Text is the concatenation of
 * `type:"text"` `data` fields; session/usage come from the terminal `end`.
 */
export function reduceGrokStreamingJson(
  events: unknown[],
  opts?: { schema?: boolean; exitCode?: number | null },
): GrokOutcome {
  const textParts: string[] = [];
  let sessionId: string | null = null;
  let usage = { inputTokens: 0, outputTokens: 0 };
  let costUsd = 0;
  let stopReason = "";
  let sawEnd = false;
  let isError = false;
  let errorMessage = "";

  for (const ev of events) {
    if (!isObject(ev)) continue;
    const type = ev["type"];
    if (type === "text" && typeof ev["data"] === "string") {
      textParts.push(ev["data"]);
    } else if (type === "end") {
      sawEnd = true;
      if (typeof ev["sessionId"] === "string") sessionId = ev["sessionId"];
      if (isObject(ev["usage"])) usage = usageFrom(ev["usage"]);
      costUsd = costFrom(ev);
      if (typeof ev["stopReason"] === "string") stopReason = ev["stopReason"];
    } else if (type === "error") {
      isError = true;
      if (typeof ev["message"] === "string") errorMessage = ev["message"];
      if (typeof ev["sessionId"] === "string") sessionId = ev["sessionId"];
    }
  }

  if (
    opts?.exitCode !== undefined &&
    opts.exitCode !== null &&
    opts.exitCode !== 0
  ) {
    isError = true;
  }
  if (!sawEnd && !isError) {
    isError = true;
  }
  if (stopReason === "refusal" || stopReason === "cancelled") {
    isError = true;
  }

  const text = isError && errorMessage ? errorMessage : textParts.join("");
  const outcome: GrokOutcome = {
    text,
    sessionId,
    costUsd,
    resultSubtype: subtypeFor(isError, stopReason),
    isError,
    usage,
  };
  return applySchema(outcome, opts?.schema);
}

/**
 * Auto-detect json vs streaming-json and fold. Used by the grok executor so a
 * single reduce path covers both `--output-format` values.
 */
export function reduceGrokEvents(
  events: unknown[],
  opts?: { schema?: boolean; exitCode?: number | null },
): GrokOutcome {
  if (looksStreaming(events)) {
    return reduceGrokStreamingJson(events, opts);
  }
  return reduceGrokJson(events, opts);
}
