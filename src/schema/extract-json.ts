// schema/extract-json.ts — tolerant extraction of a JSON object from agent text.
// schema/extract-json.ts —— 从 agent 文本中宽容地提取 JSON 对象。
//
// CLIs without a native structured-output flag (zcode, codex) ask the model for JSON via a
// prompt instruction, then JSON.parse the response. Models routinely wrap the JSON in prose
// ("Here is the result:"), markdown fences (```json … ```), or trailing commentary — all of
// which make a bare JSON.parse throw and waste the whole agent. This module extracts the first
// balanced {...} object so a wrapped response still parses. claude is immune (it has a native
// --json-schema flag the CLI enforces), so this is only wired into the zcode/codex reducers.
//
// 没有原生结构化输出 flag 的 CLI（zcode、codex）通过 prompt 指令要求 JSON，再对响应做
// JSON.parse。模型常常把 JSON 包在散文（"Here is the result:"）、markdown 围栏（```json … ```）
// 或尾部评论里——这些都会让裸 JSON.parse 抛出、浪费整个 agent。本模块提取第一个平衡的
// {...} 对象，使被包裹的响应仍可解析。claude 免疫（它有 CLI 强制的原生 --json-schema flag），
// 因此这只接入 zcode/codex 的 reducer。

/**
 * Extract the first balanced top-level JSON object from arbitrary text.
 *
 * Scans for the first `{`, then brace-counts to its matching `}`, honoring string literals
 * (so braces/quotes inside strings don't confuse the counter) and backslash escapes. Returns
 * the substring from the opening `{` to the closing `}` inclusive, or null if there is no `{`.
 * Never throws — a returned substring may still fail JSON.parse (e.g. trailing commas), and the
 * caller's parse failure → isError contract is preserved.
 *
 * 从任意文本中提取第一个平衡的顶层 JSON 对象。
 *
 * 扫描到第一个 `{`，然后按花括号计数找到其匹配的 `}`，期间识别字符串字面量（使字符串内的
 * 花括号/引号不干扰计数）和反斜杠转义。返回从开括号 `{` 到闭括号 `}`（含两端）的子串；
 * 若不存在 `{` 则返回 null。绝不抛出——返回的子串仍可能 JSON.parse 失败（如尾随逗号），
 * 调用方的「解析失败 → isError」契约保持不变。
 */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  // Unbalanced (truncated object) — return what we have so the caller's JSON.parse reports a
  // clear error rather than a silent null. 从未闭合（被截断的对象）——返回已有的部分，让调用方
  // 的 JSON.parse 报出明确错误，而不是静默返回 null。
  return text.slice(start);
}
