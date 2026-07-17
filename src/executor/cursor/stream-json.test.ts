// stream-json.test.ts — pure reducer tests for Cursor stream-json. Zero tokens.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseCursorStreamLine, reduceCursorStreamEvents } from "./stream-json.js";

function assistantText(text: string): unknown {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    session_id: "sess",
  };
}

test("parseCursorStreamLine: blank / malformed → null", () => {
  assert.equal(parseCursorStreamLine(""), null);
  assert.equal(parseCursorStreamLine("{"), null);
  assert.deepEqual(parseCursorStreamLine('{"type":"result"}'), { type: "result" });
});

test("prefers terminal result.result over assistant text", () => {
  const events = [
    { type: "system", subtype: "init", session_id: "s1" },
    assistantText("partial "),
    assistantText("segment"),
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "full final answer",
      session_id: "s1",
    },
  ];
  const out = reduceCursorStreamEvents(events);
  assert.equal(out.text, "full final answer");
  assert.equal(out.sessionId, "s1");
  assert.equal(out.isError, false);
  assert.equal(out.resultSubtype, "success");
});

test("falls back to concatenated assistant text when no result.result", () => {
  const events = [
    assistantText("A"),
    assistantText("B"),
    { type: "result", subtype: "success", is_error: false, session_id: "s2" },
  ];
  const out = reduceCursorStreamEvents(events);
  assert.equal(out.text, "AB");
});

test("is_error true on result → isError", () => {
  const events = [
    {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "boom",
      session_id: "s3",
    },
  ];
  const out = reduceCursorStreamEvents(events);
  assert.equal(out.isError, true);
  assert.equal(out.text, "boom");
});

test("missing result event → isError", () => {
  const out = reduceCursorStreamEvents([assistantText("only")]);
  assert.equal(out.isError, true);
});

test("schema: JSON.parse final text", () => {
  const events = [
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: '{"ok":true}',
      session_id: "s4",
    },
  ];
  const out = reduceCursorStreamEvents(events, { schema: true });
  assert.deepEqual(out.structuredOutput, { ok: true });
  assert.equal(out.isError, false);
});

test("schema: invalid JSON → isError", () => {
  const events = [
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "not-json",
      session_id: "s5",
    },
  ];
  const out = reduceCursorStreamEvents(events, { schema: true });
  assert.equal(out.isError, true);
  assert.equal(out.resultSubtype, "error_max_structured_output_retries");
});

test("skips pre-tool-call duplicate assistant flush (timestamp_ms + model_call_id)", () => {
  const events = [
    {
      type: "assistant",
      timestamp_ms: 1,
      model_call_id: "c1",
      message: { content: [{ type: "text", text: "DUP" }] },
      session_id: "s6",
    },
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "real" }] },
      session_id: "s6",
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "real",
      session_id: "s6",
    },
  ];
  // result.result wins; this mainly ensures the duplicate path doesn't throw
  const out = reduceCursorStreamEvents(events);
  assert.equal(out.text, "real");
});

test("non-zero exitCode forces isError", () => {
  const events = [
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "x",
      session_id: "s7",
    },
  ];
  const out = reduceCursorStreamEvents(events, { exitCode: 2 });
  assert.equal(out.isError, true);
});
