// cursor-json.ts — pure reducers over Cursor Agent CLI print-mode stdout.
// Documented shapes (cursor.com/docs/cli/reference/output-format):
//   --output-format json         → one { type:"result", result, session_id, is_error }
//   --output-format stream-json  → NDJSON; terminal event is the same result object
// Failure: non-zero exit, stderr only, no well-formed JSON.

import { extractJsonObject } from "../../schema/extract-json.js";

export interface CursorOutcome {
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

function applySchema(outcome: CursorOutcome, schema?: boolean): CursorOutcome {
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

export function parseCursorJsonLine(line: string): unknown | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function fromResult(
  ev: Record<string, unknown>,
  opts?: { schema?: boolean; exitCode?: number | null },
): CursorOutcome {
  const isError =
    ev["is_error"] === true ||
    ev["subtype"] === "error" ||
    (opts?.exitCode !== undefined && opts.exitCode !== null && opts.exitCode !== 0);
  const text = typeof ev["result"] === "string" ? ev["result"] : "";
  const sessionId =
    typeof ev["session_id"] === "string"
      ? ev["session_id"]
      : typeof ev["sessionId"] === "string"
        ? ev["sessionId"]
        : null;
  return applySchema(
    {
      text,
      sessionId,
      costUsd: 0,
      resultSubtype: isError ? "error_during_execution" : "success",
      isError,
      usage: { inputTokens: 0, outputTokens: 0 },
    },
    opts?.schema,
  );
}

export function reduceCursorJson(
  events: unknown[],
  opts?: { schema?: boolean; exitCode?: number | null },
): CursorOutcome {
  let last: Record<string, unknown> | undefined;
  for (const ev of events) {
    if (isObject(ev) && ev["type"] === "result") last = ev;
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
  return fromResult(last, opts);
}

export function reduceCursorStreamJson(
  events: unknown[],
  opts?: { schema?: boolean; exitCode?: number | null },
): CursorOutcome {
  let sessionId: string | null = null;
  let lastResult: Record<string, unknown> | undefined;
  for (const ev of events) {
    if (!isObject(ev)) continue;
    if (typeof ev["session_id"] === "string") sessionId = ev["session_id"];
    if (ev["type"] === "result") lastResult = ev;
  }
  if (lastResult !== undefined) {
    const outcome = fromResult(lastResult, opts);
    if (outcome.sessionId === null) outcome.sessionId = sessionId;
    return outcome;
  }
  return {
    text: "",
    sessionId,
    costUsd: 0,
    resultSubtype: "error_during_execution",
    isError: true,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

export function reduceCursorEvents(
  events: unknown[],
  opts?: { schema?: boolean; exitCode?: number | null },
): CursorOutcome {
  for (const ev of events) {
    if (isObject(ev) && ev["type"] === "system") {
      return reduceCursorStreamJson(events, opts);
    }
    if (isObject(ev) && ev["type"] === "assistant") {
      return reduceCursorStreamJson(events, opts);
    }
  }
  return reduceCursorJson(events, opts);
}
