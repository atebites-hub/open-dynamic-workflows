// streaming-json.ts — pure reducer over `grok --output-format streaming-json`
// stdout (one JSON object per line). No I/O, no subprocess; just parse + fold.
//
// Observed event shapes (Grok Build 0.2.x):
//   { "type": "thought", "data": "…" }
//   { "type": "text", "data": "…" }
//   { "type": "end", "stopReason": "EndTurn", "sessionId": "…", "usage": {…},
//     "structuredOutput"?: object }

/** Folded outcome of a Grok streaming-json event sequence. */
export interface GrokStreamOutcome {
  text: string;
  structuredOutput?: unknown;
  sessionId: string | null;
  resultSubtype: string;
  isError: boolean;
  usage: { inputTokens: number; outputTokens: number };
}

/** JSON.parse one line; returns null on blank/whitespace or parse failure. */
export function parseGrokStreamLine(line: string): unknown | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function toFiniteNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Fold the event stream into a single outcome.
 * - text = concatenation of all `type:"text"` `data` strings (in order)
 * - session / usage / structuredOutput come from the terminal `type:"end"` event
 * - isError when no end event is seen, stopReason is not a success form, or
 *   (when schema was requested) structured output is missing and text is not valid JSON
 */
export function reduceGrokStreamEvents(
  events: unknown[],
  opts?: { schema?: boolean; exitCode?: number | null },
): GrokStreamOutcome {
  let text = "";
  let sessionId: string | null = null;
  let sawEnd = false;
  let stopReason = "";
  let structuredOutput: unknown | undefined;

  const outcome: GrokStreamOutcome = {
    text: "",
    sessionId: null,
    resultSubtype: "error_during_execution",
    isError: true,
    usage: { inputTokens: 0, outputTokens: 0 },
  };

  for (const event of events) {
    if (!isObject(event)) continue;
    const type = event["type"];

    if (type === "text") {
      const data = event["data"];
      if (typeof data === "string") text += data;
      continue;
    }

    if (type === "end") {
      sawEnd = true;
      const sid = event["sessionId"] ?? event["session_id"];
      if (typeof sid === "string") sessionId = sid;

      const sr = event["stopReason"] ?? event["stop_reason"];
      if (typeof sr === "string") stopReason = sr;

      const usage = event["usage"];
      if (isObject(usage)) {
        outcome.usage.inputTokens = toFiniteNumber(
          usage["input_tokens"] ?? usage["inputTokens"],
        );
        outcome.usage.outputTokens = toFiniteNumber(
          usage["output_tokens"] ?? usage["outputTokens"],
        );
      }

      if ("structuredOutput" in event) {
        structuredOutput = event["structuredOutput"];
      } else if ("structured_output" in event) {
        structuredOutput = event["structured_output"];
      }
      continue;
    }

    // thought / tool / other: ignore for text
  }

  outcome.text = text;
  outcome.sessionId = sessionId;

  if (!sawEnd) {
    outcome.resultSubtype = "error_during_execution";
    outcome.isError = true;
    return outcome;
  }

  // EndTurn (and empty) count as success; anything else is an error subtype.
  const successStops = new Set(["", "EndTurn", "end_turn", "stop", "success"]);
  const okStop = successStops.has(stopReason);
  outcome.resultSubtype = okStop
    ? "success"
    : stopReason.length > 0
      ? stopReason
      : "error_during_execution";
  outcome.isError = !okStop;

  if (structuredOutput !== undefined) {
    outcome.structuredOutput = structuredOutput;
  } else if (opts?.schema === true && text.length > 0) {
    try {
      outcome.structuredOutput = JSON.parse(text);
    } catch {
      outcome.isError = true;
      outcome.resultSubtype = "error_max_structured_output_retries";
    }
  }

  if (opts?.exitCode !== undefined && opts.exitCode !== null && opts.exitCode !== 0) {
    outcome.isError = true;
    if (outcome.resultSubtype === "success") {
      outcome.resultSubtype = "error_during_execution";
    }
  }

  return outcome;
}
