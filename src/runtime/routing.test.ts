import assert from "node:assert/strict";
import { test } from "node:test";

import type { Executor } from "../types.js";
import { fingerprintRoutingPolicy, normalizeRoutingPolicy, resolveAgentRoute } from "./routing.js";

const executor = async () => ({
  text: "ok",
  sessionId: null,
  costUsd: 0,
  durationMs: 0,
  resultSubtype: "success" as const,
  isError: false,
  usage: { inputTokens: 0, outputTokens: 0 },
});
const executors: Record<string, Executor> = { codex: executor };

test("routing policy normalizes fixed keys and freezes the result", () => {
  const policy = normalizeRoutingPolicy({ reasoningEffort: " high ", model: " gpt ", executor: " codex " }, executors);
  assert.deepEqual(policy, { executor: "codex", model: "gpt", reasoningEffort: "high" });
  assert.ok(Object.isFrozen(policy));
});

test("routing policy fingerprint is deterministic across input key order", () => {
  const a = normalizeRoutingPolicy({ executor: "codex", model: "gpt", reasoningEffort: "high" }, executors);
  const b = normalizeRoutingPolicy({ model: "gpt", reasoningEffort: "high", executor: "codex" }, executors);
  assert.equal(fingerprintRoutingPolicy(a), fingerprintRoutingPolicy(b));
});

test("routing policy fingerprints different executor model or effort values differently", () => {
  const base = normalizeRoutingPolicy({ executor: "codex", model: "gpt", reasoningEffort: "high" }, executors);
  assert.notEqual(fingerprintRoutingPolicy(base), fingerprintRoutingPolicy({ ...base, model: "other" }));
  assert.notEqual(fingerprintRoutingPolicy(base), fingerprintRoutingPolicy({ ...base, reasoningEffort: "low" }));
  assert.notEqual(fingerprintRoutingPolicy(base), fingerprintRoutingPolicy({ ...base, executor: "other" }));
});

test("routing policy rejects non-object input", () => {
  assert.throws(() => normalizeRoutingPolicy(null, executors), /object/);
  assert.throws(() => normalizeRoutingPolicy("nope", executors), /object/);
});

test("routing policy rejects unknown fields", () => {
  assert.throws(() => normalizeRoutingPolicy({ executor: "codex", model: "gpt", reasoningEffort: "high", extra: true }, executors), /unknown field/);
});

test("routing policy rejects empty or whitespace-only fields", () => {
  assert.throws(() => normalizeRoutingPolicy({ executor: " ", model: "gpt", reasoningEffort: "high" }, executors), /executor/);
  assert.throws(() => normalizeRoutingPolicy({ executor: "codex", model: " ", reasoningEffort: "high" }, executors), /model/);
  assert.throws(() => normalizeRoutingPolicy({ executor: "codex", model: "gpt", reasoningEffort: " " }, executors), /reasoningEffort/);
});

test("routing policy rejects an unregistered executor", () => {
  assert.throws(() => normalizeRoutingPolicy({ executor: "claude", model: "gpt", reasoningEffort: "high" }, executors), /unregistered executor/);
});

test("resolveAgentRoute fills omitted fields and rejects conflicts", () => {
  const policy = normalizeRoutingPolicy({ executor: "codex", model: "gpt", reasoningEffort: "high" }, executors);
  assert.deepEqual(resolveAgentRoute(policy, {}), policy);
  assert.deepEqual(resolveAgentRoute(policy, { executor: "codex", model: "gpt", reasoningEffort: "high" }), policy);
  assert.throws(() => resolveAgentRoute(policy, { model: "other" }), /model conflict/);
  assert.deepEqual(resolveAgentRoute(undefined, { model: "gpt" }), { model: "gpt" });
});
