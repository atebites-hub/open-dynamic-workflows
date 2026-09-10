// Public API. 公共 API。
// The core: types + the runtime entry. 核心：类型 + 运行时入口。
export * from "./types.js";
export { runWorkflow } from "./runtime/run.js";
export { fingerprintRoutingPolicy, normalizeRoutingPolicy, resolveAgentRoute } from "./runtime/routing.js";

// Bundled executor adapters — ONE adapter per CLI, swap or extend for your model/harness.
// 内置的 executor 适配器 —— 每个 CLI 一个适配器，可替换或扩展成你的模型/harness。
export { claudeExecutor, buildClaudeArgs } from "./executor/claude/claude.js";
export { codexExecutor, buildCodexArgs } from "./executor/codex/codex.js";
export { grokExecutor, buildGrokArgs } from "./executor/grok/grok.js";
export { cursorExecutor, buildCursorArgs, resolveCursorBin, isCursorCliBinary } from "./executor/cursor/cursor.js";
export { zcodeExecutor, buildZcodeArgs } from "./executor/zcode/zcode.js";
export { antigravityExecutor, buildAntigravityArgs, reduceAntigravityEvents } from "./executor/antigravity/antigravity.js";
export { copilotExecutor, buildCopilotArgs, reduceCopilotEvents } from "./executor/copilot/copilot.js";

// Pure reducers + the shared subprocess driver — exposed so hosts can build their own adapters.
// 纯归约器 + 共享子进程 driver —— 导出以便 host 自行构建适配器。
export { reduceStreamJsonEvents, parseStreamJsonLine } from "./executor/claude/stream-json.js";
export { reduceCodexEvents, parseCodexJsonLine } from "./executor/codex/codex-jsonl.js";
export { reduceGrokEvents, reduceGrokJson, reduceGrokStreamingJson, parseGrokJsonLine } from "./executor/grok/grok-json.js";
export { reduceCursorEvents, reduceCursorJson, reduceCursorStreamJson, parseCursorJsonLine } from "./executor/cursor/cursor-json.js";
export { reduceZcodeEnvelope, parseZcodeEnvelopeLine } from "./executor/zcode/zcode-envelope.js";
export { makeSubprocessExecutor } from "./executor/subprocess.js";

import { claudeExecutor } from "./executor/claude/claude.js";
import { codexExecutor } from "./executor/codex/codex.js";
import { grokExecutor } from "./executor/grok/grok.js";
import { cursorExecutor } from "./executor/cursor/cursor.js";
import { zcodeExecutor } from "./executor/zcode/zcode.js";
import { antigravityExecutor } from "./executor/antigravity/antigravity.js";
import { copilotExecutor } from "./executor/copilot/copilot.js";

// Out-of-the-box registry, ready to pass as RunOptions.executors (or extend).
// There is still no implicit default: agent() must name one, unless the host sets
// RunOptions.defaultExecutor (the Grok-hosted plugin does this for zcode).
// 开箱即用的注册表，可直接作为 RunOptions.executors 传入（或扩展）。
// 仍然没有隐式默认：agent() 必须指名，除非 host 设置了 RunOptions.defaultExecutor
// （Grok 托管的插件会把默认设为 zcode）。
export const builtinExecutors = {
  cursor: cursorExecutor,
  zcode: zcodeExecutor,
  grok: grokExecutor,
  claude: claudeExecutor,
  codex: codexExecutor,
  antigravity: antigravityExecutor,
  copilot: copilotExecutor,
};
