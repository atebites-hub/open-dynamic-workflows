// validate.test.ts — unit tests for schema compaction (Bug 4).
// validate.test.ts —— schema 压缩的单元测试（Bug 4）。
//
// Run: npx tsx --test src/schema/validate.test.ts
// 运行：npx tsx --test src/schema/validate.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { compactSchema, compactSchemaToJson } from "./validate.js";

// ────────────────────────────────────────────────────────────────────────────
// (1) top-level doc keywords are dropped; structural keywords stay
// (1) 顶层文档关键字被丢弃；结构性关键字保留
// ────────────────────────────────────────────────────────────────────────────

test("(1) compactSchema drops description/title/examples/$comment/default, keeps structure", () => {
  const schema = {
    type: "object",
    description: "the root object",
    title: "Root",
    properties: {
      name: { type: "string", description: "the name" },
      count: { type: "number", default: 0, examples: [1, 2] },
    },
    required: ["name"],
    $comment: "internal note",
  };
  const compact = compactSchema(schema) as Record<string, any>;
  // Doc keywords gone at the root and inside properties.
  // 根级与 properties 内的文档关键字都消失了。
  assert.equal("description" in compact, false);
  assert.equal("title" in compact, false);
  assert.equal("$comment" in compact, false);
  assert.equal(compact.properties.name.description, undefined);
  assert.equal(compact.properties.count.default, undefined);
  assert.equal(compact.properties.count.examples, undefined);
  // Structural keywords preserved.
  // 结构性关键字保留。
  assert.equal(compact.type, "object");
  assert.equal(compact.properties.name.type, "string");
  assert.equal(compact.properties.count.type, "number");
  assert.deepEqual(compact.required, ["name"]);
});

// ────────────────────────────────────────────────────────────────────────────
// (2) input is not mutated
// (2) 入参不被修改
// ────────────────────────────────────────────────────────────────────────────

test("(2) compactSchema does not mutate its input", () => {
  const schema = { type: "object", description: "x", properties: { a: { type: "string", description: "y" } } };
  const snapshot = JSON.parse(JSON.stringify(schema));
  compactSchema(schema);
  assert.deepEqual(schema, snapshot);
});

// ────────────────────────────────────────────────────────────────────────────
// (3) recursion through arrays (items), anyOf, and nested objects
// (3) 经由数组（items）、anyOf 及嵌套对象的递归
// ────────────────────────────────────────────────────────────────────────────

test("(3) compactSchema recurses through items / anyOf / nested objects", () => {
  const schema = {
    type: "object",
    properties: {
      tags: {
        type: "array",
        items: { type: "string", description: "a tag" },
      },
      choice: {
        anyOf: [
          { type: "string", description: "str option" },
          { type: "number", description: "num option" },
        ],
      },
      nested: {
        type: "object",
        properties: { deep: { type: "boolean", description: "way down" } },
      },
    },
  };
  const compact = compactSchema(schema) as Record<string, any>;
  assert.equal(compact.properties.tags.items.description, undefined);
  assert.equal(compact.properties.choice.anyOf[0].description, undefined);
  assert.equal(compact.properties.choice.anyOf[1].description, undefined);
  assert.equal(compact.properties.nested.properties.deep.description, undefined);
  // Structure intact.
  // 结构完好。
  assert.equal(compact.properties.tags.items.type, "string");
  assert.equal(compact.properties.nested.properties.deep.type, "boolean");
});

// ────────────────────────────────────────────────────────────────────────────
// (4) compactSchemaToJson yields valid JSON when under the cap
// (4) 在上限内时 compactSchemaToJson 产出合法 JSON
// ────────────────────────────────────────────────────────────────────────────

test("(4) compactSchemaToJson under the cap parses back to the compacted schema", () => {
  const schema = { type: "object", description: "drop me", properties: { a: { type: "string" } } };
  const json = compactSchemaToJson(schema);
  assert.deepEqual(JSON.parse(json), compactSchema(schema));
});

// ────────────────────────────────────────────────────────────────────────────
// (5) over the cap → truncated with a visible note (still prompt-friendly)
// (5) 超过上限 → 带可见提示地截断（仍适合塞进 prompt）
// ────────────────────────────────────────────────────────────────────────────

test("(5) compactSchemaToJson over the cap truncates with a visible note", () => {
  // Use a genuinely large STRUCTURAL schema (many fields), since descriptions would be compacted
  // away and never reach the cap. 用真正庞大的【结构性】schema（很多字段），因为 description 会被
  // 压缩掉、到不了上限。
  const fields: Record<string, any> = {};
  for (let i = 0; i < 400; i++) fields[`field_${i}`] = { type: "string", minLength: 1 };
  const big = { type: "object", properties: fields };
  const json = compactSchemaToJson(big, 200);
  assert.ok(json.length <= 200 + 200, "truncated output stays near the cap + note");
  assert.match(json, /schema truncated/);
});
