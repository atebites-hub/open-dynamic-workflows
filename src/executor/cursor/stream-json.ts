// stream-json.ts — pure reducer over `cursor-agent --print --output-format stream-json`
// stdout (NDJSON). No I/O, no subprocess; just parse + fold.
//
// Documented event types (Cursor CLI output-format reference):
//   system / user / assistant / tool_call / result
// Terminal success:
//   { "type":"result", "subtype":"success", "is_error":false,
//     "result":"<full text>", "session_id":"…" }
// Prefer `result.result` for final text (docs: skip assistant events if you only
// want the finished answer). Fallback: concatenate assistant text blocks.

/** Folded outcome of a Cursor stream-json event sequence. */
export interface CursorStreamOutcome {
  text: string;
  structuredOutput?: unknown;
  sessionId: string | null;
  resultSubtype: string;
  isError: boolean;
  usage: { inputTokens: number; outputTokens: number };
}

/** JSON.parse one line; returns null on blank/whitespace or parse failure. */
export function parseCursorStreamLine(line: string): unknown | null {
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

/** Concatenate all text blocks in an assistant message's content array. */
function extractAssistantText(event: Record<string, unknown>): string {
  const message = event["message"];
  if (!isObject(message)) return "";
  const content = message["content"];
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    if (!isObject(block)) continue;
    if (block["type"] === "text" && typeof block["text"] === "string") {
      out += block["text"];
    }
  }
  return out;
}

/**
 * Fold the event stream into a single outcome.
 * - Prefer terminal `result.result` for text when present
 * - Else concatenate assistant message text blocks
 * - isError from result.is_error, missing result, non-zero exit, or schema parse fail
 */
export function reduceCursorStreamEvents(
  events: unknown[],
  opts?: { schema?: boolean; exitCode?: number | null },
): CursorStreamOutcome {
  let assistantText = "";
  let resultText: string | null = null;
  let sessionId: string | null = null;
  let sawResult = false;

  const outcome: CursorStreamOutcome = {
    text: "",
    sessionId: null,
    resultSubtype: "error_during_execution",
    isError: true,
    usage: { inputTokens: 0, outputTokens: 0 },
  };

  for (const event of events) {
    if (!isObject(event)) continue;
    const type = event["type"];

    if (type === "system" || type === "user" || type === "tool_call") {
      const sid = event["session_id"];
      if (typeof sid === "string" && sessionId === null) sessionId = sid;
      continue;
    }

    if (type === "assistant") {
      // Skip partial-output duplicates when timestamp_ms+model_call_id present
      // (pre-tool flush) or when both absent after streaming — docs say only
      // timestamp_ms present + model_call_id absent is new delta text.
      // Without --stream-partial-output, each assistant event is a full segment.
      const hasTs = "timestamp_ms" in event;
      const hasCall = "model_call_id" in event;
      if (hasTs && hasCall) continue; // duplicate buffered flush
      if (!hasTs && !hasCall && "message" in event === false) continue;
      assistantText += extractAssistantText(event);
      const sid = event["session_id"];
      if (typeof sid === "string") sessionId = sid;
      continue;
    }

    if (type === "result") {
      sawResult = true;
      const subtype = event["subtype"];
      outcome.resultSubtype =
        typeof subtype === "string" && subtype.length > 0 ? subtype : "success";

      outcome.isError =
        typeof event["is_error"] === "boolean"
          ? (event["is_error"] as boolean)
          : outcome.resultSubtype !== "success";

      const sid = event["session_id"];
      if (typeof sid === "string") sessionId = sid;

      if (typeof event["result"] === "string") {
        resultText = event["result"] as string;
      }

      const usage = event["usage"];
      if (isObject(usage)) {
        outcome.usage.inputTokens = toFiniteNumber(
          usage["input_tokens"] ?? usage["inputTokens"],
        );
        outcome.usage.outputTokens = toFiniteNumber(
          usage["output_tokens"] ?? usage["outputTokens"],
        );
      }

      if ("structured_output" in event) {
        outcome.structuredOutput = event["structured_output"];
      } else if ("structuredOutput" in event) {
        outcome.structuredOutput = event["structuredOutput"];
      }
      continue;
    }
  }

  outcome.text = resultText !== null ? resultText : assistantText;
  outcome.sessionId = sessionId;

  if (!sawResult) {
    outcome.resultSubtype = "error_during_execution";
    outcome.isError = true;
  }

  if (
    opts?.schema === true &&
    outcome.structuredOutput === undefined &&
    outcome.text.length > 0
  ) {
    try {
      outcome.structuredOutput = JSON.parse(outcome.text);
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
