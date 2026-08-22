import assert from "node:assert/strict";
import { test } from "node:test";

import { buildZcodeArgs } from "./zcode.js";

test("zcode forwards an explicit reasoning effort beside the model", () => {
  const args = buildZcodeArgs({ prompt: "hello", cwd: "/tmp", model: "zai/glm", reasoningEffort: "high" });
  assert.deepEqual(args.slice(-6), ["--mode", "yolo", "--model", "zai/glm", "--reasoning-effort", "high"]);
});

test("zcode omits reasoning effort when it is not supplied", () => {
  const args = buildZcodeArgs({ prompt: "hello", cwd: "/tmp", model: "zai/glm" });
  assert.equal(args.includes("--reasoning-effort"), false);
});
