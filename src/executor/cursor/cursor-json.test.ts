// cursor-json.test.ts — fixtures match Cursor's documented print-mode shapes
// (cursor.com/docs/cli/reference/output-format).
//
// Run: npx tsx --test src/executor/cursor/cursor-json.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseCursorJsonLine,
  reduceCursorEvents,
  reduceCursorJson,
  reduceCursorStreamJson,
} from "./cursor-json.js";

const SESSION = "c6b62c6f-7ead-4fd6-9922-e952131177ff";

function eventsFromLines(lines: string[]): unknown[] {
  const out: unknown[] = [];
  for (const line of lines) {
    const ev = parseCursorJsonLine(line);
    if (ev !== null) out.push(ev);
  }
  return out;
}

function jsonResult(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1234,
    duration_api_ms: 1234,
    result: "Here's a summary of the codebase...",
    session_id: SESSION,
    request_id: "req-1",
    ...over,
  });
}

function streamInit(): string {
  return JSON.stringify({
    type: "system",
    subtype: "init",
    apiKeySource: "login",
    cwd: "/Users/user/project",
    session_id: SESSION,
    model: "Claude 4 Sonnet",
    permissionMode: "default",
  });
}

function streamAssistant(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    session_id: SESSION,
  });
}

test("parseCursorJsonLine skips blank and non-JSON chatter", () => {
  assert.equal(parseCursorJsonLine(""), null);
  assert.equal(parseCursorJsonLine("not json"), null);
  assert.deepEqual(parseCursorJsonLine('{"type":"result","result":"hi"}'), {
    type: "result",
    result: "hi",
  });
});

test("json reducer: documented result object → text, session_id, not error", () => {
  const outcome = reduceCursorJson(eventsFromLines([jsonResult()]));
  assert.equal(outcome.text, "Here's a summary of the codebase...");
  assert.equal(outcome.sessionId, SESSION);
  assert.equal(outcome.isError, false);
  assert.equal(outcome.resultSubtype, "success");
});

test("json reducer: is_error true → isError", () => {
  const outcome = reduceCursorJson(
    eventsFromLines([jsonResult({ is_error: true, result: "failed" })]),
  );
  assert.equal(outcome.isError, true);
  assert.equal(outcome.text, "failed");
});

test("json reducer: no result event → execution error", () => {
  const outcome = reduceCursorJson([]);
  assert.equal(outcome.isError, true);
  assert.equal(outcome.text, "");
});

test("json reducer: schema request parses result text", () => {
  const outcome = reduceCursorJson(
    eventsFromLines([jsonResult({ result: '{"ok":true}' })]),
    { schema: true },
  );
  assert.equal(outcome.isError, false);
  assert.deepEqual(outcome.structuredOutput, { ok: true });
});

test("stream-json reducer: terminal result supplies text and session_id", () => {
  const outcome = reduceCursorStreamJson(
    eventsFromLines([
      streamInit(),
      streamAssistant("I'll read the file"),
      jsonResult({ result: "Done summary" }),
    ]),
  );
  assert.equal(outcome.text, "Done summary");
  assert.equal(outcome.sessionId, SESSION);
  assert.equal(outcome.isError, false);
});

test("combined reducer auto-detects json vs stream-json fixtures", () => {
  const jsonOut = reduceCursorEvents(eventsFromLines([jsonResult({ result: "JSON_OK" })]));
  assert.equal(jsonOut.text, "JSON_OK");
  const streamOut = reduceCursorEvents(
    eventsFromLines([streamInit(), jsonResult({ result: "STREAM_OK" })]),
  );
  assert.equal(streamOut.text, "STREAM_OK");
});
