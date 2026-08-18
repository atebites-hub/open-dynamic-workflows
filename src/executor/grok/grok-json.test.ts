// grok-json.test.ts — unit tests for grok headless json + streaming-json reducers.
// Fixtures use the REAL shapes from Grok's documented `--output-format json` and
// `--output-format streaming-json` stdout (user-guide/14-headless-mode.md).
//
// Run: npx tsx --test src/executor/grok/grok-json.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseGrokJsonLine,
  reduceGrokEvents,
  reduceGrokJson,
  reduceGrokStreamingJson,
} from "./grok-json.js";

const SESSION_ID = "abc123";

function eventsFromLines(lines: string[]): unknown[] {
  const out: unknown[] = [];
  for (const line of lines) {
    const ev = parseGrokJsonLine(line);
    if (ev !== null) out.push(ev);
  }
  return out;
}

/** Documented `--output-format json` success object (no `type` field). */
function jsonResult(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    text: "Here's a summary of the codebase...",
    stopReason: "end_turn",
    sessionId: SESSION_ID,
    requestId: "xyz789",
    num_turns: 7,
    usage: {
      input_tokens: 7210,
      cache_read_input_tokens: 41000,
      cache_creation_input_tokens: 0,
      output_tokens: 1893,
      reasoning_tokens: 412,
      total_tokens: 50103,
    },
    total_cost_usd: 0.01268905,
    ...over,
  });
}

/** Documented json-format failure object. */
function jsonError(message: string): string {
  return JSON.stringify({ type: "error", message });
}

function streamText(data: string): string {
  return JSON.stringify({ type: "text", data });
}

function streamThought(data: string): string {
  return JSON.stringify({ type: "thought", data });
}

function streamEnd(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "end",
    stopReason: "end_turn",
    sessionId: SESSION_ID,
    requestId: "xyz789",
    usage: {
      input_tokens: 812,
      output_tokens: 45,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      reasoning_tokens: 0,
    },
    num_turns: 7,
    ...over,
  });
}

function streamError(message: string): string {
  return JSON.stringify({ type: "error", message });
}

test("parseGrokJsonLine skips blank and non-JSON chatter", () => {
  assert.equal(parseGrokJsonLine(""), null);
  assert.equal(parseGrokJsonLine("   "), null);
  assert.equal(parseGrokJsonLine("not json"), null);
  assert.deepEqual(parseGrokJsonLine('{"type":"text","data":"hi"}'), {
    type: "text",
    data: "hi",
  });
});

test("json reducer: documented success object → text, sessionId, usage, not error", () => {
  const events = eventsFromLines([jsonResult()]);
  const outcome = reduceGrokJson(events);

  assert.equal(outcome.text, "Here's a summary of the codebase...");
  assert.equal(outcome.sessionId, SESSION_ID);
  assert.equal(outcome.isError, false);
  assert.equal(outcome.resultSubtype, "success");
  assert.equal(outcome.usage.inputTokens, 7210);
  assert.equal(outcome.usage.outputTokens, 1893);
  assert.equal(outcome.costUsd, 0.01268905);
});

test("json reducer: documented {type:error,message} → isError and message text", () => {
  const events = eventsFromLines([
    jsonError("Couldn't start session: authentication failed"),
  ]);
  const outcome = reduceGrokJson(events);

  assert.equal(outcome.isError, true);
  assert.match(outcome.text, /Couldn't start session/);
  assert.equal(outcome.resultSubtype, "error_during_execution");
});

test("json reducer: schema request JSON.parses text into structuredOutput", () => {
  const events = eventsFromLines([
    jsonResult({ text: '{"ok":true,"n":3}' }),
  ]);
  const outcome = reduceGrokJson(events, { schema: true });
  assert.equal(outcome.isError, false);
  assert.deepEqual(outcome.structuredOutput, { ok: true, n: 3 });
});

test("json reducer: schema request with prose-wrapped JSON still extracts the object", () => {
  const events = eventsFromLines([
    jsonResult({ text: "Here is the result:\n```json\n{\"verdict\":\"real\"}\n```" }),
  ]);
  const outcome = reduceGrokJson(events, { schema: true });
  assert.equal(outcome.isError, false);
  assert.deepEqual(outcome.structuredOutput, { verdict: "real" });
});

test("json reducer: schema request with unparseable text flags isError", () => {
  const events = eventsFromLines([jsonResult({ text: "not an object" })]);
  const outcome = reduceGrokJson(events, { schema: true });
  assert.equal(outcome.isError, true);
});

test("streaming-json reducer: concatenates text events and takes sessionId from end", () => {
  const events = eventsFromLines([
    streamThought("Analyzing the directory structure..."),
    streamText("Here's a "),
    streamText("summary"),
    streamEnd(),
  ]);
  const outcome = reduceGrokStreamingJson(events);

  assert.equal(outcome.text, "Here's a summary");
  assert.equal(outcome.sessionId, SESSION_ID);
  assert.equal(outcome.isError, false);
  assert.equal(outcome.resultSubtype, "success");
  assert.equal(outcome.usage.inputTokens, 812);
  assert.equal(outcome.usage.outputTokens, 45);
});

test("streaming-json reducer: error event → isError with message", () => {
  const events = eventsFromLines([
    streamText("partial"),
    streamError("Couldn't start session: ..."),
  ]);
  const outcome = reduceGrokStreamingJson(events);
  assert.equal(outcome.isError, true);
  assert.match(outcome.text, /Couldn't start session/);
});

test("streaming-json reducer: no events → execution error, empty text", () => {
  const outcome = reduceGrokStreamingJson([]);
  assert.equal(outcome.isError, true);
  assert.equal(outcome.text, "");
  assert.equal(outcome.sessionId, null);
  assert.equal(outcome.resultSubtype, "error_during_execution");
});

test("combined reducer auto-detects json vs streaming-json fixtures", () => {
  const jsonOutcome = reduceGrokEvents(eventsFromLines([jsonResult({ text: "JSON_OK" })]));
  assert.equal(jsonOutcome.text, "JSON_OK");
  assert.equal(jsonOutcome.sessionId, SESSION_ID);

  const streamOutcome = reduceGrokEvents(
    eventsFromLines([streamText("STREAM_OK"), streamEnd({ sessionId: "stream-sess" })]),
  );
  assert.equal(streamOutcome.text, "STREAM_OK");
  assert.equal(streamOutcome.sessionId, "stream-sess");
});

test("combined reducer: non-zero exitCode without a success payload is an error", () => {
  const outcome = reduceGrokEvents([], { exitCode: 1 });
  assert.equal(outcome.isError, true);
});
