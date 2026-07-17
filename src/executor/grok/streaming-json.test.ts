// streaming-json.test.ts — pure reducer tests for Grok streaming-json. Zero tokens.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseGrokStreamLine, reduceGrokStreamEvents } from "./streaming-json.js";

test("parseGrokStreamLine: blank / malformed → null; object → object", () => {
  assert.equal(parseGrokStreamLine(""), null);
  assert.equal(parseGrokStreamLine("   "), null);
  assert.equal(parseGrokStreamLine("not-json"), null);
  assert.deepEqual(parseGrokStreamLine('{"type":"text","data":"hi"}'), {
    type: "text",
    data: "hi",
  });
});

test("concatenates text data in order; ignores thought", () => {
  const events = [
    { type: "thought", data: "thinking…" },
    { type: "text", data: "Hel" },
    { type: "text", data: "lo" },
    {
      type: "end",
      stopReason: "EndTurn",
      sessionId: "s1",
      usage: { input_tokens: 10, output_tokens: 2 },
    },
  ];
  const out = reduceGrokStreamEvents(events);
  assert.equal(out.text, "Hello");
  assert.equal(out.sessionId, "s1");
  assert.equal(out.isError, false);
  assert.equal(out.resultSubtype, "success");
  assert.equal(out.usage.inputTokens, 10);
  assert.equal(out.usage.outputTokens, 2);
});

test("structuredOutput on end event is preserved", () => {
  const events = [
    { type: "text", data: '{"ok":true}' },
    {
      type: "end",
      stopReason: "EndTurn",
      sessionId: "s2",
      structuredOutput: { ok: true },
    },
  ];
  const out = reduceGrokStreamEvents(events, { schema: true });
  assert.deepEqual(out.structuredOutput, { ok: true });
  assert.equal(out.isError, false);
});

test("schema without structuredOutput: JSON.parse text", () => {
  const events = [
    { type: "text", data: '{"ok":true}' },
    { type: "end", stopReason: "EndTurn", sessionId: "s3" },
  ];
  const out = reduceGrokStreamEvents(events, { schema: true });
  assert.deepEqual(out.structuredOutput, { ok: true });
});

test("schema with invalid JSON text → isError", () => {
  const events = [
    { type: "text", data: "not-json" },
    { type: "end", stopReason: "EndTurn", sessionId: "s4" },
  ];
  const out = reduceGrokStreamEvents(events, { schema: true });
  assert.equal(out.isError, true);
  assert.equal(out.resultSubtype, "error_max_structured_output_retries");
});

test("missing end event → isError", () => {
  const out = reduceGrokStreamEvents([{ type: "text", data: "partial" }]);
  assert.equal(out.isError, true);
  assert.equal(out.resultSubtype, "error_during_execution");
});

test("non-zero exitCode forces isError", () => {
  const events = [
    { type: "text", data: "x" },
    { type: "end", stopReason: "EndTurn", sessionId: "s5" },
  ];
  const out = reduceGrokStreamEvents(events, { exitCode: 1 });
  assert.equal(out.isError, true);
});
