import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCodexArgs } from "./codex.js";

test("model overrides get a compatible reasoning effort", () => {
  const base = { prompt: "test", cwd: "/tmp" };

  assert.deepEqual(buildCodexArgs({ ...base, model: "gpt-5.4-mini" }), [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--color",
    "never",
    "--sandbox",
    "workspace-write",
    "-m",
    "gpt-5.4-mini",
    "-c",
    'model_reasoning_effort="medium"',
    "-",
  ]);
  assert.ok(
    buildCodexArgs({ ...base, model: "gpt-5.4-mini", reasoningEffort: "high" }).includes(
      'model_reasoning_effort="high"',
    ),
  );
  assert.equal(buildCodexArgs(base).includes("-c"), false);
});
