// schema/validate.ts — ajv wrapper, --json-schema arg building, safety-net validate (SPEC §7).
// schema/validate.ts —— ajv 封装、构造 --json-schema 参数、兜底校验（SPEC §7）。

import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";
import type { JsonSchema } from "../types.js";

// Single shared ajv instance. strict:false so unknown keywords (CLI-flavored schemas,
// 单个共享的 ajv 实例。strict:false 让未知关键字（CLI 风格的 schema、
// vendor extensions) don't crash compilation; allErrors so errorsText reports everything.
// 厂商扩展）不会让编译崩溃；allErrors 让 errorsText 报出全部错误。
const ajv = new Ajv({ allErrors: true, strict: false });

// Compiled validators cached by a stable stringify of the schema.
// 编译后的校验器以 schema 的稳定 stringify 结果为键做缓存。
const validatorCache = new Map<string, ValidateFunction>();

/** The exact JSON handed to `claude --json-schema <json>`. */
/** 传给 `claude --json-schema <json>` 的那串确切 JSON。 */
export function schemaToCliArg(schema: JsonSchema): string {
  return JSON.stringify(schema);
}

export interface ValidationResult {
  ok: boolean;
  errors?: string;
}

function getValidator(schema: JsonSchema): ValidateFunction {
  const cacheKey = JSON.stringify(schema);
  const existing = validatorCache.get(cacheKey);
  if (existing) return existing;
  const compiled = ajv.compile(schema);
  validatorCache.set(cacheKey, compiled);
  return compiled;
}

/** Re-validate a value against the schema as a safety net for the CLI's structured output. */
/** 对值再次按 schema 做校验，作为 CLI 结构化输出的兜底。 */
export function validateAgainstSchema(schema: JsonSchema, value: unknown): ValidationResult {
  const validate = getValidator(schema);
  const valid = validate(value);
  if (valid) return { ok: true };
  const errors = ajv.errorsText(validate.errors, { separator: "; " });
  return { ok: false, errors };
}

/** SPEC §7: structured-output schema root MUST be type:"object". */
/** SPEC §7：结构化输出 schema 的根必须是 type:"object"。 */
export function assertObjectRootSchema(schema: JsonSchema): void {
  if (schema["type"] !== "object") {
    throw new Error(
      `structured-output schema root must be type:"object" (got ${JSON.stringify(
        schema["type"],
      )}); discriminated unions must be expressed flat (enum discriminant + optional fields), not a root oneOf`,
    );
  }
}

/**
 * Doc-only keywords dropped when a schema is stringified into a prompt/argv for CLIs that lack a
 * native structured-output flag (zcode). `description`, `title`, `examples`, `$comment`, and
 * `default` bloat the prompt — which for zcode rides on argv (no stdin), approaching the ~256KB
 * OS argv ceiling — without changing what the model is asked to produce. Structural keywords
 * (type/properties/required/items/enum/format/etc.) are all preserved. Returns a NEW object; the
 * input is untouched. Recurses into object-valued keywords (properties, items, anyOf, …) so
 * descriptions nested deep in the schema are also removed.
 *
 * 把 schema 序列化进 prompt/argv 时（针对没有原生结构化输出 flag 的 CLI，如 zcode）需要丢弃的
 * 纯文档关键字。`description`、`title`、`examples`、`$comment`、`default` 会让 prompt 膨胀——对
 * zcode 而言它走 argv（无 stdin），逼近 OS 约 256KB 的 argv 上限——却不会改变要求模型产出的内容。
 * 结构性关键字（type/properties/required/items/enum/format 等）全部保留。返回一个新对象；不修改入参。
 * 会递归进入对象型关键字（properties、items、anyOf …），从而深层嵌套的 description 也被移除。
 */
const DOC_KEYWORDS = new Set(["description", "title", "examples", "$comment", "default"]);

export function compactSchema(schema: JsonSchema): JsonSchema {
  return compactValue(schema) as JsonSchema;
}

function compactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(compactValue);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(obj)) {
    if (DOC_KEYWORDS.has(key)) continue;
    out[key] = compactValue(child);
  }
  return out;
}

/**
 * Stringify a schema for prompt/argv injection: compacted (doc keywords dropped) and length-capped.
 * If the compacted JSON still exceeds `maxChars`, it is truncated with a visible note so the model
 * sees that the schema is partial — preferable to silently blowing past the argv ceiling. The
 * default cap leaves generous headroom under the ~256KB OS argv limit.
 *
 * 把 schema 序列化以注入 prompt/argv：先压缩（去掉文档关键字），再做长度收口。若压缩后的 JSON
 * 仍超过 `maxChars`，则带可见提示地截断——让模型知道 schema 不完整——优于默默突破 argv 上限。
 * 默认上限在 OS 约 256KB 的 argv 限制下留有充裕余量。
 */
export function compactSchemaToJson(schema: JsonSchema, maxChars = 200_000): string {
  const json = JSON.stringify(compactSchema(schema));
  if (json.length <= maxChars) return json;
  return json.slice(0, maxChars) + '\n…(schema truncated: it exceeded the prompt/argv budget; follow the visible structure)';
}
