// grok.test.ts — argv builder + real grokExecutor against a fake `grok` on PATH.
// The fake binary prints the documented json / streaming-json shapes; the test
// drives the shipped executor (not a reimplementation).
//
// Run: npx tsx --test src/executor/grok/grok.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { buildGrokArgs, grokExecutor } from "./grok.js";

const base = { prompt: "Reply with OK only.", cwd: "/tmp/odw-grok-cwd" };

function assertHeadlessFlags(args: string[]): void {
  assert.ok(args.includes("-p") || args.includes("--single"), "headless -p/--single");
  const fmtIdx = args.indexOf("--output-format");
  assert.ok(fmtIdx >= 0, "must set --output-format");
  assert.ok(
    args[fmtIdx + 1] === "json" || args[fmtIdx + 1] === "streaming-json",
    "output format must be json or streaming-json",
  );
  assert.ok(args.includes("--always-approve") || args.includes("--yolo"));
  assert.ok(args.includes("--sandbox"));
  assert.ok(args.includes("--no-auto-update"));
  assert.ok(!args.includes("--tools"), "must not use the broken --tools allowlist");
}

test("buildGrokArgs: headless flags, no --tools allowlist", () => {
  const args = buildGrokArgs(base);
  assertHeadlessFlags(args);
  const pIdx = args.indexOf("-p");
  assert.equal(args[pIdx + 1], base.prompt);
  assert.ok(args.includes("--cwd"));
  assert.equal(args[args.indexOf("--cwd") + 1], base.cwd);
  assert.equal(args[args.indexOf("--sandbox") + 1], "workspace");
  assert.equal(args[args.indexOf("--output-format") + 1], "streaming-json");
});

test("buildGrokArgs: model, effort, resume, schema, rules", () => {
  const args = buildGrokArgs({
    ...base,
    model: "grok-4",
    reasoningEffort: "high",
    resumeSessionId: "sess-1",
    schema: { type: "object", properties: { ok: { type: "boolean" } } },
    appendSystemPrompt: "You are a planning subagent.",
  });
  assertHeadlessFlags(args);
  assert.ok(args.includes("-m") || args.includes("--model"));
  assert.ok(args.includes("--effort") || args.includes("--reasoning-effort"));
  assert.ok(args.includes("--resume"));
  assert.ok(args.includes("--json-schema"));
  assert.ok(args.includes("--rules"));
  assert.equal(args[args.indexOf("--output-format") + 1], "json");
  const schemaIdx = args.indexOf("--json-schema");
  const parsed = JSON.parse(args[schemaIdx + 1] ?? "null");
  assert.equal(parsed.type, "object");
});

function writeFakeGrok(dir: string, text: string, sessionId: string): string {
  const bin = join(dir, "grok");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--tools")) {
  console.error("refusing --tools allowlist");
  process.exit(2);
}
let format = "plain";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--output-format") format = args[i + 1] || format;
}
if (format === "json") {
  console.log(JSON.stringify({
    text: ${JSON.stringify(text)},
    stopReason: "end_turn",
    sessionId: ${JSON.stringify(sessionId)},
    requestId: "fake-req",
  }));
} else {
  console.log(JSON.stringify({ type: "text", data: ${JSON.stringify(text)} }));
  console.log(JSON.stringify({
    type: "end",
    stopReason: "end_turn",
    sessionId: ${JSON.stringify(sessionId)},
    requestId: "fake-req",
  }));
}
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

test("grokExecutor: fake grok on PATH returns its stdout text and sessionId", async () => {
  const binDir = mkdtempSync(join(tmpdir(), "odw-fake-grok-"));
  writeFakeGrok(binDir, "ODW_FAKE_GROK_OK", "fake-grok-session");
  const prevPath = process.env.PATH;
  const prevBin = process.env.GROK_BIN;
  delete process.env.GROK_BIN;
  process.env.PATH = `${binDir}${delimiter}${prevPath ?? ""}`;
  try {
    const res = await grokExecutor({
      prompt: "Reply with OK only.",
      cwd: mkdtempSync(join(tmpdir(), "odw-grok-cwd-")),
    });
    assert.equal(res.isError, false);
    assert.equal(res.text, "ODW_FAKE_GROK_OK");
    assert.equal(res.sessionId, "fake-grok-session");
  } finally {
    process.env.PATH = prevPath;
    if (prevBin === undefined) delete process.env.GROK_BIN;
    else process.env.GROK_BIN = prevBin;
  }
});

test("grokExecutor: GROK_BIN override is what gets spawned", async () => {
  const binDir = mkdtempSync(join(tmpdir(), "odw-fake-grok-bin-"));
  const bin = writeFakeGrok(binDir, "ODW_FAKE_GROK_BIN_OK", "bin-session");
  const prevBin = process.env.GROK_BIN;
  process.env.GROK_BIN = bin;
  try {
    const res = await grokExecutor({
      prompt: "via GROK_BIN",
      cwd: mkdtempSync(join(tmpdir(), "odw-grok-cwd-")),
    });
    assert.equal(res.text, "ODW_FAKE_GROK_BIN_OK");
    assert.equal(res.sessionId, "bin-session");
    assert.equal(res.isError, false);
  } finally {
    if (prevBin === undefined) delete process.env.GROK_BIN;
    else process.env.GROK_BIN = prevBin;
  }
});
