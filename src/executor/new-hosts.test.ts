import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { antigravityExecutor, buildAntigravityArgs, reduceAntigravityEvents } from "./antigravity/antigravity.js";
import { copilotExecutor, buildCopilotArgs, reduceCopilotEvents } from "./copilot/copilot.js";

const opts = { prompt: "probe", cwd: "/tmp/assigned-worktree" };
test("Antigravity uses a new project at the assigned cwd without a permission bypass", () => {
  const args = buildAntigravityArgs({ ...opts, model: "gemini-3.8-flash-high", reasoningEffort: "high" });
  assert.ok(args.includes("--new-project"));
  assert.ok(!args.includes("--project"));
  assert.ok(!args.includes("--dangerously-skip-permissions"));
  assert.equal(args[args.indexOf("--mode") + 1], "accept-edits");
  assert.throws(() => buildAntigravityArgs({ ...opts, reasoningEffort: "ultra" }));
});
test("Antigravity does not soft-pass SUCCESS with denied actions or missing terminal data", () => {
  const denied = reduceAntigravityEvents([{ event: "result", result: { status: "SUCCESS", response: "", denied_actions: [{ action: "write_file" }] } }], 0);
  assert.equal(denied.isError, true);
  assert.equal(denied.resultSubtype, "permission_denied");
  assert.equal(reduceAntigravityEvents([], 0).isError, true);
  const success = reduceAntigravityEvents([{ event: "result", result: { status: "SUCCESS", response: "ok", conversation_id: "agy-session", usage: { input_tokens: 2, output_tokens: 1 } } }], 0);
  assert.equal(success.text, "ok"); assert.equal(success.sessionId, "agy-session");
  assert.equal(reduceAntigravityEvents([{ status: "SUCCESS" }], 1).isError, true);
});
test("Copilot keeps path checks and forwards model/effort without all-permission flags", () => {
  const args = buildCopilotArgs({ ...opts, model: "chosen-model", reasoningEffort: "high" });
  assert.equal(args[args.indexOf("-C") + 1], opts.cwd);
  assert.equal(args[args.indexOf("--model") + 1], "chosen-model");
  assert.equal(args[args.indexOf("--effort") + 1], "high");
  for (const flag of ["--allow-all", "--allow-all-paths", "--allow-all-urls", "--yolo"]) assert.ok(!args.includes(flag));
});
test("Copilot requires terminal success and preserves quota errors", () => {
  const events = [{ type: "assistant.message", data: { content: '{"ok":true}' } }, { type: "result", exitCode: 0, sessionId: "copilot-session" }];
  const success = reduceCopilotEvents(events, 0, true);
  assert.equal(success.isError, false); assert.deepEqual(success.structuredOutput, { ok: true });
  assert.equal(reduceCopilotEvents(events.slice(0, 1), 0).isError, true);
  const denied = reduceCopilotEvents([...events, { type: "session.error", data: { errorCode: "quota_exceeded", message: "monthly quota exhausted" } }], 1);
  assert.equal(denied.resultSubtype, "quota_exceeded"); assert.equal(denied.text, "monthly quota exhausted");
});
for (const host of ["antigravity", "copilot"] as const) {
  test(`${host} executor really spawns in the supplied directory with the ODW leaf marker`, async () => {
    const directory = mkdtempSync(join(tmpdir(), `odw-${host}-executor-`));
    const binary = join(directory, "fake-cli");
    writeFileSync(binary, `#!/usr/bin/env node\nif(process.env.ODW_LEAF!=='1')process.exit(9);\nconst cwd=process.cwd();\n${host === "antigravity" ? "console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:cwd,conversation_id:'session'}}));" : "console.log(JSON.stringify({type:'assistant.message',data:{content:cwd}}));console.log(JSON.stringify({type:'result',exitCode:0,sessionId:'session'}));"}\n`);
    chmodSync(binary, 0o755);
    const variable = host === "antigravity" ? "ANTIGRAVITY_BIN" : "COPILOT_BIN";
    const before = process.env[variable]; process.env[variable] = binary;
    try {
      const value = await (host === "antigravity" ? antigravityExecutor : copilotExecutor)({ prompt: "probe", cwd: directory });
      assert.equal(value.isError, false);
      assert.equal(realpathSync(value.text), realpathSync(directory));
    } finally { if (before === undefined) delete process.env[variable]; else process.env[variable] = before; }
  });
}
