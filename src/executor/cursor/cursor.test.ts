// cursor.test.ts — argv builder + binary resolution + fake cursor-agent executor.
//
// Run: npx tsx --test src/executor/cursor/cursor.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { buildCursorArgs, cursorExecutor, resolveCursorBin } from "./cursor.js";

const base = { prompt: "Reply with OK only.", cwd: "/tmp/odw-cursor-cwd" };

function assertPrintFlags(args: string[]): void {
  assert.ok(args.includes("-p") || args.includes("--print"), "headless -p/--print");
  const fmtIdx = args.indexOf("--output-format");
  assert.ok(fmtIdx >= 0, "must set --output-format");
  const fmt = args[fmtIdx + 1];
  assert.ok(fmt === "json" || fmt === "stream-json", "json or stream-json");
  assert.ok(args.includes("--force") || args.includes("--yolo"));
  assert.ok(args.includes("--trust"), "headless must skip the workspace-trust prompt");
  assert.ok(args.includes("--approve-mcps"), "headless must auto-approve MCP servers");
  assert.ok(!args.includes("--plugin-dir"), "must not reload plugins (fork-bomb)");
  // Cursor's --sandbox is enabled|disabled (not grok's "workspace"). enabled denies
  // network by default; disabled is the dangerously-open analog. Leave the CLI default.
  const sandboxIdx = args.indexOf("--sandbox");
  if (sandboxIdx >= 0) {
    assert.notEqual(args[sandboxIdx + 1], "disabled");
  }
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

const CURSOR_HELP = `Usage: agent [options]
  -p, --print
  --output-format <text|json|stream-json>
  -f, --force
  --trust
  --approve-mcps
  --sandbox <enabled|disabled>
  --workspace <dir>
`;

const GROK_HELP = `Usage: grok [options]
  -p, --single <prompt>
  --output-format <json|streaming-json>
  --always-approve
  --sandbox workspace
`;

function writeFakeBin(dir: string, name: string, help: string, text: string, sessionId: string): string {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, name);
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(${JSON.stringify(help)});
  process.exit(0);
}
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

function writeEnvEchoCursor(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, name);
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(${JSON.stringify(CURSOR_HELP)});
  process.exit(0);
}
const payload = {
  ODW_CURSOR_LEAF: process.env.ODW_CURSOR_LEAF ?? null,
  CURSOR_PLUGIN_ROOT: process.env.CURSOR_PLUGIN_ROOT ?? null,
  PLUGIN_ROOT: process.env.PLUGIN_ROOT ?? null,
  GROK_PLUGIN_ROOT: process.env.GROK_PLUGIN_ROOT ?? null,
};
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: JSON.stringify(payload),
  session_id: "env-session",
}));
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function writeFailingCursor(dir: string, name: string, stderr: string): string {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, name);
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(${JSON.stringify(CURSOR_HELP)});
  process.exit(0);
}
process.stderr.write(${JSON.stringify(stderr)});
process.exit(2);
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

/**
 * Directories needed so `#!/usr/bin/env node` fakes can answer `--help`,
 * without leaking a host `agent` / `cursor-agent` onto PATH.
 */
function shebangPath(): string {
  return [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter);
}

function withResolveEnv(opts: {
  path: string;
  home: string;
  cursorBin?: string;
}): () => void {
  const prevPath = process.env.PATH;
  const prevHome = process.env.HOME;
  const prevBin = process.env.CURSOR_BIN;
  process.env.PATH = opts.path;
  process.env.HOME = opts.home;
  if (opts.cursorBin === undefined) delete process.env.CURSOR_BIN;
  else process.env.CURSOR_BIN = opts.cursorBin;
  return () => {
    process.env.PATH = prevPath;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevBin === undefined) delete process.env.CURSOR_BIN;
    else process.env.CURSOR_BIN = prevBin;
  };
}

test("cursorExecutor: fake cursor-agent on PATH returns its stdout text", async () => {
  const binDir = mkdtempSync(join(tmpdir(), "odw-fake-cursor-"));
  const home = mkdtempSync(join(tmpdir(), "odw-home-"));
  writeFakeBin(binDir, "cursor-agent", CURSOR_HELP, "ODW_FAKE_CURSOR_OK", "fake-cursor-session");
  const restore = withResolveEnv({ path: `${binDir}${delimiter}${process.env.PATH ?? ""}`, home });
  try {
    const res = await cursorExecutor({
      prompt: "Reply with OK only.",
      cwd: mkdtempSync(join(tmpdir(), "odw-cursor-cwd-")),
    });
    assert.equal(res.isError, false);
    assert.equal(res.text, "ODW_FAKE_CURSOR_OK");
    assert.equal(res.sessionId, "fake-cursor-session");
  } finally {
    restore();
  }
});

test("cursorExecutor: CURSOR_BIN override is what gets spawned", async () => {
  const binDir = mkdtempSync(join(tmpdir(), "odw-fake-cursor-bin-"));
  const home = mkdtempSync(join(tmpdir(), "odw-home-"));
  const bin = writeFakeBin(binDir, "my-cursor", CURSOR_HELP, "ODW_FAKE_CURSOR_BIN_OK", "bin-session");
  const restore = withResolveEnv({ path: process.env.PATH ?? "", home, cursorBin: bin });
  try {
    const res = await cursorExecutor({
      prompt: "via CURSOR_BIN",
      cwd: mkdtempSync(join(tmpdir(), "odw-cursor-cwd-")),
    });
    assert.equal(res.text, "ODW_FAKE_CURSOR_BIN_OK");
    assert.equal(res.sessionId, "bin-session");
    assert.equal(res.isError, false);
  } finally {
    restore();
  }
});

test("cursorExecutor: stderr-only non-zero exit surfaces stderr as text", async () => {
  const binDir = mkdtempSync(join(tmpdir(), "odw-fake-cursor-err-"));
  const home = mkdtempSync(join(tmpdir(), "odw-home-"));
  writeFailingCursor(binDir, "cursor-agent", "Authentication required. Run `agent login`.");
  const restore = withResolveEnv({ path: `${binDir}${delimiter}${process.env.PATH ?? ""}`, home });
  try {
    const res = await cursorExecutor({
      prompt: "will fail",
      cwd: mkdtempSync(join(tmpdir(), "odw-cursor-cwd-")),
    });
    assert.equal(res.isError, true);
    assert.match(res.text, /Authentication required/);
  } finally {
    restore();
  }
});

test("cursorExecutor: nested leaf env is set and plugin-root vars are stripped", async () => {
  const binDir = mkdtempSync(join(tmpdir(), "odw-fake-cursor-env-"));
  const home = mkdtempSync(join(tmpdir(), "odw-home-"));
  writeEnvEchoCursor(binDir, "cursor-agent");
  const restore = withResolveEnv({ path: `${binDir}${delimiter}${process.env.PATH ?? ""}`, home });
  const prevCursorRoot = process.env.CURSOR_PLUGIN_ROOT;
  const prevPluginRoot = process.env.PLUGIN_ROOT;
  const prevGrokRoot = process.env.GROK_PLUGIN_ROOT;
  process.env.CURSOR_PLUGIN_ROOT = "/should/not/leak/cursor";
  process.env.PLUGIN_ROOT = "/should/not/leak/plugin";
  process.env.GROK_PLUGIN_ROOT = "/should/not/leak/grok";
  try {
    const res = await cursorExecutor({
      prompt: "env",
      cwd: mkdtempSync(join(tmpdir(), "odw-cursor-cwd-")),
    });
    assert.equal(res.isError, false);
    const env = JSON.parse(res.text) as Record<string, string | null>;
    assert.equal(env.ODW_CURSOR_LEAF, "1");
    assert.equal(env.CURSOR_PLUGIN_ROOT, null);
    assert.equal(env.PLUGIN_ROOT, null);
    assert.equal(env.GROK_PLUGIN_ROOT, null);
  } finally {
    restore();
    if (prevCursorRoot === undefined) delete process.env.CURSOR_PLUGIN_ROOT;
    else process.env.CURSOR_PLUGIN_ROOT = prevCursorRoot;
    if (prevPluginRoot === undefined) delete process.env.PLUGIN_ROOT;
    else process.env.PLUGIN_ROOT = prevPluginRoot;
    if (prevGrokRoot === undefined) delete process.env.GROK_PLUGIN_ROOT;
    else process.env.GROK_PLUGIN_ROOT = prevGrokRoot;
  }
});

test("resolveCursorBin prefers cursor-agent over agent on PATH", () => {
  const binDir = mkdtempSync(join(tmpdir(), "odw-resolve-cursor-"));
  const home = mkdtempSync(join(tmpdir(), "odw-home-"));
  writeFakeBin(binDir, "cursor-agent", CURSOR_HELP, "x", "s");
  writeFakeBin(binDir, "agent", CURSOR_HELP, "y", "s");
  const restore = withResolveEnv({ path: `${binDir}${delimiter}${process.env.PATH ?? ""}`, home });
  try {
    assert.equal(resolveCursorBin(), join(binDir, "cursor-agent"));
  } finally {
    restore();
  }
});

test("resolveCursorBin: Grok agent on PATH is never selected (the Grok-agent trap)", () => {
  const grokDir = mkdtempSync(join(tmpdir(), "odw-grok-bin-"));
  const home = mkdtempSync(join(tmpdir(), "odw-home-"));
  writeFakeBin(grokDir, "agent", GROK_HELP, "GROK_NOT_CURSOR", "grok");
  // PATH has Grok's `agent` plus shebang dirs. HOME has no ~/.local/bin Cursor install.
  const restore = withResolveEnv({ path: `${grokDir}${delimiter}${shebangPath()}`, home });
  try {
    const resolved = resolveCursorBin();
    assert.notEqual(resolved, join(grokDir, "agent"));
    assert.equal(resolved, "cursor-agent");
  } finally {
    restore();
  }
});

test("resolveCursorBin: Grok agent earlier on PATH does not beat Cursor's agent", () => {
  const grokDir = mkdtempSync(join(tmpdir(), "odw-grok-first-"));
  const cursorDir = mkdtempSync(join(tmpdir(), "odw-cursor-agent-"));
  const home = mkdtempSync(join(tmpdir(), "odw-home-"));
  writeFakeBin(grokDir, "agent", GROK_HELP, "grok", "g");
  writeFakeBin(cursorDir, "agent", CURSOR_HELP, "cursor", "c");
  const restore = withResolveEnv({
    path: `${grokDir}${delimiter}${cursorDir}${delimiter}${shebangPath()}`,
    home,
  });
  try {
    assert.equal(resolveCursorBin(), join(cursorDir, "agent"));
  } finally {
    restore();
  }
});

test("resolveCursorBin: Grok install path ~/.grok/bin/agent is skipped even without help", () => {
  const home = mkdtempSync(join(tmpdir(), "odw-home-"));
  const grokBin = join(home, ".grok", "bin");
  writeFakeBin(grokBin, "agent", GROK_HELP, "grok", "g");
  const restore = withResolveEnv({ path: `${grokBin}${delimiter}${shebangPath()}`, home });
  try {
    assert.notEqual(resolveCursorBin(), join(grokBin, "agent"));
    assert.equal(resolveCursorBin(), "cursor-agent");
  } finally {
    restore();
  }
});

test("resolveCursorBin: Cursor's agent (not cursor-agent) is used when it fingerprints as Cursor", () => {
  const cursorDir = mkdtempSync(join(tmpdir(), "odw-cursor-only-"));
  const home = mkdtempSync(join(tmpdir(), "odw-home-"));
  writeFakeBin(cursorDir, "agent", CURSOR_HELP, "cursor", "c");
  const restore = withResolveEnv({ path: `${cursorDir}${delimiter}${shebangPath()}`, home });
  try {
    assert.equal(resolveCursorBin(), join(cursorDir, "agent"));
  } finally {
    restore();
  }
});

test("resolveCursorBin: ~/.local/bin/cursor-agent is found even when not on PATH", () => {
  const home = mkdtempSync(join(tmpdir(), "odw-home-"));
  const emptyPath = mkdtempSync(join(tmpdir(), "odw-empty-path-"));
  const localBin = join(home, ".local", "bin");
  writeFakeBin(localBin, "cursor-agent", CURSOR_HELP, "local", "l");
  const restore = withResolveEnv({ path: `${emptyPath}${delimiter}${shebangPath()}`, home });
  try {
    assert.equal(resolveCursorBin(), join(localBin, "cursor-agent"));
  } finally {
    restore();
  }
});

test("resolveCursorBin: ~/.local/bin/agent is used only when it fingerprints as Cursor", () => {
  const home = mkdtempSync(join(tmpdir(), "odw-home-"));
  const emptyPath = mkdtempSync(join(tmpdir(), "odw-empty-path-"));
  const localBin = join(home, ".local", "bin");
  writeFakeBin(localBin, "agent", CURSOR_HELP, "local-agent", "l");
  const restore = withResolveEnv({ path: `${emptyPath}${delimiter}${shebangPath()}`, home });
  try {
    assert.equal(resolveCursorBin(), join(localBin, "agent"));
  } finally {
    restore();
  }
});

test("resolveCursorBin: CURSOR_BIN wins over PATH and well-known locations", () => {
  const binDir = mkdtempSync(join(tmpdir(), "odw-override-"));
  const home = mkdtempSync(join(tmpdir(), "odw-home-"));
  const localBin = join(home, ".local", "bin");
  writeFakeBin(binDir, "cursor-agent", CURSOR_HELP, "path", "p");
  writeFakeBin(localBin, "cursor-agent", CURSOR_HELP, "home", "h");
  const override = writeFakeBin(binDir, "my-cursor", CURSOR_HELP, "override", "o");
  const restore = withResolveEnv({
    path: binDir,
    home,
    cursorBin: override,
  });
  try {
    assert.equal(resolveCursorBin(), override);
  } finally {
    restore();
  }
});
