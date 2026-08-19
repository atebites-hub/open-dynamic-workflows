// cursor.test.ts — argv builder + real cursorExecutor against a fake cursor-agent.
//
// Run: npx tsx --test src/executor/cursor/cursor.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { buildCursorArgs, cursorExecutor, resolveCursorBin } from "./cursor.js";

const base = { prompt: "Reply with OK only.", cwd: "/tmp/odw-cursor-cwd" };

function assertPrintFlags(args: string[]): void {
  assert.ok(args.includes("-p") || args.includes("--print"), "headless -p/--print");
  const fmtIdx = args.indexOf("--output-format");
  assert.ok(fmtIdx >= 0, "must set --output-format");
  const fmt = args[fmtIdx + 1];
  assert.ok(fmt === "json" || fmt === "stream-json", "json or stream-json");
  assert.ok(args.includes("--force") || args.includes("--yolo"));
}

test("buildCursorArgs: print-mode flags and prompt last", () => {
  const args = buildCursorArgs(base);
  assertPrintFlags(args);
  assert.equal(args[args.length - 1], base.prompt);
  assert.equal(args[args.indexOf("--workspace") + 1], base.cwd);
  assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
});

test("buildCursorArgs: model, resume, schema fold into prompt", () => {
  const args = buildCursorArgs({
    ...base,
    model: "sonnet-4",
    resumeSessionId: "chat-1",
    schema: { type: "object", properties: { ok: { type: "boolean" } } },
    appendSystemPrompt: "You are a planning subagent.",
  });
  assertPrintFlags(args);
  assert.ok(args.includes("--model"));
  assert.ok(args.includes("--resume"));
  assert.equal(args[args.indexOf("--output-format") + 1], "json");
  const prompt = args[args.length - 1] ?? "";
  assert.match(prompt, /JSON Schema/);
  assert.match(prompt, /planning subagent/);
});

function writeFakeCursor(dir: string, name: string, text: string, sessionId: string): string {
  const bin = join(dir, name);
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
let format = "text";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--output-format") format = args[i + 1] || format;
}
if (format === "json") {
  console.log(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: ${JSON.stringify(text)},
    session_id: ${JSON.stringify(sessionId)},
  }));
} else {
  console.log(JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: ${JSON.stringify(sessionId)},
  }));
  console.log(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: ${JSON.stringify(text)},
    session_id: ${JSON.stringify(sessionId)},
  }));
}
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

test("cursorExecutor: fake cursor-agent on PATH returns its stdout text", async () => {
  const binDir = mkdtempSync(join(tmpdir(), "odw-fake-cursor-"));
  writeFakeCursor(binDir, "cursor-agent", "ODW_FAKE_CURSOR_OK", "fake-cursor-session");
  const prevPath = process.env.PATH;
  const prevBin = process.env.CURSOR_BIN;
  delete process.env.CURSOR_BIN;
  process.env.PATH = `${binDir}${delimiter}${prevPath ?? ""}`;
  try {
    const res = await cursorExecutor({
      prompt: "Reply with OK only.",
      cwd: mkdtempSync(join(tmpdir(), "odw-cursor-cwd-")),
    });
    assert.equal(res.isError, false);
    assert.equal(res.text, "ODW_FAKE_CURSOR_OK");
    assert.equal(res.sessionId, "fake-cursor-session");
  } finally {
    process.env.PATH = prevPath;
    if (prevBin === undefined) delete process.env.CURSOR_BIN;
    else process.env.CURSOR_BIN = prevBin;
  }
});

test("cursorExecutor: CURSOR_BIN override is what gets spawned", async () => {
  const binDir = mkdtempSync(join(tmpdir(), "odw-fake-cursor-bin-"));
  const bin = writeFakeCursor(binDir, "my-cursor", "ODW_FAKE_CURSOR_BIN_OK", "bin-session");
  const prevBin = process.env.CURSOR_BIN;
  process.env.CURSOR_BIN = bin;
  try {
    const res = await cursorExecutor({
      prompt: "via CURSOR_BIN",
      cwd: mkdtempSync(join(tmpdir(), "odw-cursor-cwd-")),
    });
    assert.equal(res.text, "ODW_FAKE_CURSOR_BIN_OK");
    assert.equal(res.sessionId, "bin-session");
    assert.equal(res.isError, false);
  } finally {
    if (prevBin === undefined) delete process.env.CURSOR_BIN;
    else process.env.CURSOR_BIN = prevBin;
  }
});

test("resolveCursorBin prefers cursor-agent over agent on PATH", () => {
  const binDir = mkdtempSync(join(tmpdir(), "odw-resolve-cursor-"));
  writeFakeCursor(binDir, "cursor-agent", "x", "s");
  writeFakeCursor(binDir, "agent", "y", "s");
  const prevPath = process.env.PATH;
  const prevBin = process.env.CURSOR_BIN;
  delete process.env.CURSOR_BIN;
  process.env.PATH = `${binDir}${delimiter}${prevPath ?? ""}`;
  try {
    assert.equal(resolveCursorBin(), join(binDir, "cursor-agent"));
  } finally {
    process.env.PATH = prevPath;
    if (prevBin === undefined) delete process.env.CURSOR_BIN;
    else process.env.CURSOR_BIN = prevBin;
  }
});
