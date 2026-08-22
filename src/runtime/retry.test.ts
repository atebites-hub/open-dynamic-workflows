// retry.test.ts — unit tests for transient-failure classification + backoff.
// retry.test.ts —— 瞬时失败分类 + 退避的单元测试。
//
// Run: npx tsx --test src/runtime/retry.test.ts
// 运行：npx tsx --test src/runtime/retry.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AbortError,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_BACKOFF_MS,
  abortableSleep,
  backoffDelayMs,
  isRetriable,
} from "./retry.js";
import type { ExecResult } from "../types.js";

function result(over: Partial<ExecResult>): ExecResult {
  return {
    text: "",
    sessionId: null,
    costUsd: 0,
    durationMs: 0,
    resultSubtype: "success",
    isError: false,
    usage: { inputTokens: 0, outputTokens: 0 },
    ...over,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// (1) isRetriable: only error_during_execution (and only when isError) is retriable
// (1) isRetriable：只有 error_during_execution（且 isError 时）可重试
// ────────────────────────────────────────────────────────────────────────────

test("(1a) error_during_execution + isError → retriable (the transient CLI-crash case)", () => {
  assert.equal(isRetriable(result({ isError: true, resultSubtype: "error_during_execution" })), true);
});

test("(1b) success → not retriable", () => {
  assert.equal(isRetriable(result({ isError: false, resultSubtype: "success" })), false);
});

test("(1c) permanent subtypes → not retriable (exhausted budgets, schema retries)", () => {
  assert.equal(isRetriable(result({ isError: true, resultSubtype: "error_max_turns" })), false);
  assert.equal(
    isRetriable(result({ isError: true, resultSubtype: "error_max_structured_output_retries" })),
    false,
  );
});

test("(1d) timeout / idle_timeout → not retried by default (expensive + usually futile)", () => {
  assert.equal(isRetriable(result({ isError: true, resultSubtype: "timeout" })), false);
  assert.equal(isRetriable(result({ isError: true, resultSubtype: "idle_timeout" })), false);
});

test("(1e) error_during_execution WITHOUT isError flag → not retriable (defensive)", () => {
  // A result that carries the retriable subtype but didn't set isError is not a failure to retry.
  // 带着「可重试」subtype 但没设 isError 的结果，不是需要重试的失败。
  assert.equal(isRetriable(result({ isError: false, resultSubtype: "error_during_execution" })), false);
});

// ────────────────────────────────────────────────────────────────────────────
// (2) backoffDelayMs: exponential, capped, deterministic
// (2) backoffDelayMs：指数、有上限、确定性
// ────────────────────────────────────────────────────────────────────────────

test("(2) backoffDelayMs doubles per attempt and caps at 8× base", () => {
  const base = DEFAULT_RETRY_BACKOFF_MS; // 1000
  assert.equal(backoffDelayMs(0), 0);            // no delay before the initial call
  assert.equal(backoffDelayMs(1), base);         // 1×
  assert.equal(backoffDelayMs(2), base * 2);     // 2×
  assert.equal(backoffDelayMs(3), base * 4);     // 4×
  assert.equal(backoffDelayMs(4), base * 8);     // cap
  assert.equal(backoffDelayMs(5), base * 8);     // still capped
  assert.equal(backoffDelayMs(10), base * 8);    // hard cap holds
});

test("(2b) backoffDelayMs honors a custom base", () => {
  assert.equal(backoffDelayMs(2, 500), 1000);
  assert.equal(backoffDelayMs(4, 500), 4000); // 500 * 8 cap
});

// ────────────────────────────────────────────────────────────────────────────
// (3) abortableSleep: resolves normally; rejects fast on abort; default constants
// (3) abortableSleep：正常 resolve；abort 时快速 reject；默认常量
// ────────────────────────────────────────────────────────────────────────────

test("(3a) abortableSleep resolves after the delay", async () => {
  const start = Date.now();
  await abortableSleep(60);
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 50, `slept ~60ms (got ${elapsed}ms)`);
});

test("(3b) abortableSleep rejects immediately if the signal is already aborted", async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => abortableSleep(1000, ac.signal), (e: unknown) => e instanceof AbortError);
});

test("(3c) abortableSleep rejects early when the signal aborts mid-sleep", async () => {
  const ac = new AbortController();
  const promise = abortableSleep(5000, ac.signal);
  // Abort shortly after — should reject well before the 5s sleep completes.
  // 不久后 abort —— 应在 5s 睡眠完成前就 reject。
  setTimeout(() => ac.abort(), 40);
  const start = Date.now();
  await assert.rejects(() => promise, (e: unknown) => e instanceof AbortError);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 500, `rejected fast (got ${elapsed}ms; expected <500ms)`);
});

test("(3d) defaults are sensible", () => {
  assert.equal(DEFAULT_MAX_RETRIES, 2);
  assert.equal(DEFAULT_RETRY_BACKOFF_MS, 1000);
});
