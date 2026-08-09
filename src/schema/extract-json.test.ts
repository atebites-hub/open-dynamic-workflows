// extract-json.test.ts — unit tests for tolerant JSON-object extraction.
// extract-json.test.ts —— 宽容 JSON 对象提取的单元测试。
//
// Run: npx tsx --test src/schema/extract-json.test.ts
// 运行：npx tsx --test src/schema/extract-json.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { extractJsonObject } from "./extract-json.js";

// ────────────────────────────────────────────────────────────────────────────
// (1) bare JSON object — returns it verbatim
// (1) 裸 JSON 对象 —— 原样返回
// ────────────────────────────────────────────────────────────────────────────

test("(1) bare JSON object round-trips through JSON.parse", () => {
  const json = '{"ok":true,"n":3}';
  const extracted = extractJsonObject(json);
  assert.equal(extracted, json);
  assert.deepEqual(JSON.parse(extracted!), { ok: true, n: 3 });
});

// ────────────────────────────────────────────────────────────────────────────
// (2) prose before the JSON (the failure mode that killed review:rendering)
// (2) JSON 前有散文（正是让 review:rendering 失败的那种）
// ────────────────────────────────────────────────────────────────────────────

test("(2) prose before JSON is stripped", () => {
  const text = 'I have finished. Returning the review now.\n{"lens":"physics","ok":true}';
  const extracted = extractJsonObject(text);
  assert.deepEqual(JSON.parse(extracted!), { lens: "physics", ok: true });
});

// ────────────────────────────────────────────────────────────────────────────
// (3) ```json fenced block (with a language tag), plus trailing prose
// (3) ```json 围栏块（带语言标签）+ 尾部散文
// ────────────────────────────────────────────────────────────────────────────

test("(3) fenced ```json block with trailing prose parses", () => {
  const text = 'Here you go:\n```json\n{"a":1,"b":{"c":2}}\n```\nLet me know.';
  const extracted = extractJsonObject(text);
  assert.deepEqual(JSON.parse(extracted!), { a: 1, b: { c: 2 } });
});

// ────────────────────────────────────────────────────────────────────────────
// (4) braces inside strings must not confuse the counter
// (4) 字符串内的花括号不得干扰计数
// ────────────────────────────────────────────────────────────────────────────

test("(4) braces and quotes inside string values are ignored by the brace counter", () => {
  // The inner "} and {" is inside a string; the object closes at the real final }.
  // 字符串内的 "} and {" 不应参与计数；对象在真正的末尾 } 处闭合。
  const text = '{"code":"function(){ return \\"} and {\\"; }","ok":true}';
  const extracted = extractJsonObject(text);
  assert.deepEqual(JSON.parse(extracted!), {
    code: 'function(){ return "} and {"; }',
    ok: true,
  });
});

// ────────────────────────────────────────────────────────────────────────────
// (5) deeply nested objects close at the right brace
// (5) 深层嵌套对象在正确的花括号处闭合
// ────────────────────────────────────────────────────────────────────────────

test("(5) deeply nested objects extract the full outer object", () => {
  const inner = '{"x":{"y":{"z":[1,2,{"w":3}]}}}';
  const text = `preamble ${inner} postamble`;
  const extracted = extractJsonObject(text);
  assert.equal(extracted, inner);
  assert.deepEqual(JSON.parse(extracted!), { x: { y: { z: [1, 2, { w: 3 }] } } });
});

// ────────────────────────────────────────────────────────────────────────────
// (6) no `{` at all → null
// (6) 完全没有 `{` → null
// ────────────────────────────────────────────────────────────────────────────

test("(6) text with no opening brace returns null", () => {
  assert.equal(extractJsonObject("just prose, no json here"), null);
  assert.equal(extractJsonObject(""), null);
});

// ────────────────────────────────────────────────────────────────────────────
// (7) truncated / unbalanced object → returns best-effort substring (parse will fail)
// (7) 截断/未闭合对象 → 尽力返回子串（解析会失败）
// ────────────────────────────────────────────────────────────────────────────

test("(7) truncated object returns the tail (caller's JSON.parse then reports the error)", () => {
  const text = '{"ok":true,"items":[1,2,3'; // never closes
  const extracted = extractJsonObject(text);
  assert.equal(extracted, text);
  // Caller will JSON.parse this and get a clean SyntaxError (not a silent null).
  assert.throws(() => JSON.parse(extracted!), SyntaxError);
});

// ────────────────────────────────────────────────────────────────────────────
// (8) JSON whose first value is an array — extractor skips to the first object.
// This is deliberate: schemas are rooted at type:"object", so the object is what we want.
// (8) 第一个值是数组的 JSON —— 提取器跳到第一个对象。
// 这是有意的：schema 根都是 type:"object"，所以我们要的是对象。
// ────────────────────────────────────────────────────────────────────────────

test("(8) leading array is skipped; the first object after it is extracted", () => {
  const text = '[1,2,3] then {"ok":true}';
  const extracted = extractJsonObject(text);
  assert.deepEqual(JSON.parse(extracted!), { ok: true });
});
