// types.ts — the FROZEN contract for the whole runtime.
// types.ts —— 整个运行时的冻结契约。
//
// Every module codes against these types. Do not change a shape without updating
// 每个模块都针对这些类型编码。改任何形状都要同步更新
// every consumer. Public API types and internal cross-module shapes both live here so
// 每一个消费方。公开 API 类型和内部跨模块形状都放在这里，
// there is one source of truth.
// 这样就有唯一的事实来源。

// ────────────────────────────────────────────────────────────────────────────
// JSON Schema (loose — we pass it through to the CLI and to ajv)
// JSON Schema（宽松定义 —— 我们把它透传给 CLI 和 ajv）
// ────────────────────────────────────────────────────────────────────────────

export type JsonSchema = Record<string, unknown>;

// ────────────────────────────────────────────────────────────────────────────
// meta block
// meta 块
// ────────────────────────────────────────────────────────────────────────────

export interface PhaseMeta {
  readonly title: string;
  readonly detail?: string;
  readonly model?: string;
}

export interface WorkflowMeta {
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly phases?: ReadonlyArray<PhaseMeta>;
  readonly model?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// agent() options
// agent() 选项
// ────────────────────────────────────────────────────────────────────────────

export interface AgentOptions {
  /** Required: names one key of RunOptions.executors. Enforced at runtime — missing or unknown throws. */
  /** 必填：指向 RunOptions.executors 的某个 key。运行时强制——缺失或未知则 throw。 */
  executor: string;
  /** Display label; defaults to a truncated prompt or `agent-N`. */
  /** 显示标签；默认取截断后的 prompt 或 `agent-N`。 */
  label?: string;
  /** Explicit progress group. Use inside parallel()/pipeline() stages. */
  /** 显式的进度分组。在 parallel()/pipeline() 各阶段内部使用。 */
  phase?: string;
  /** JSON Schema forcing structured output; agent() then resolves to the object. */
  /** 强制结构化输出的 JSON Schema；之后 agent() 解析为该对象。 */
  schema?: JsonSchema;
  /** Model override for this call. */
  /** 本次调用的模型覆盖。 */
  model?: string;
  /** Executor-specific reasoning effort. Codex model overrides default to medium when omitted. */
  /** 执行器专用的推理强度。Codex 覆盖模型时，未指定则默认为 medium。 */
  reasoningEffort?: string;
  /** Run this agent in a fresh git worktree (parallel file mutation). EXPENSIVE. */
  /** 在全新的 git worktree 中运行此 agent（并行修改文件）。开销很大。 */
  isolation?: "worktree";
  /** Named subagent system-prompt preset. */
  /** 命名的子 agent system-prompt 预设。 */
  agentType?: string;
  /**
   * Per-agent override of the run-wide retry budget for transient (error_during_execution)
   * failures. Set to 0 to disable retry for this agent; set higher for a known-flaky node. Overrides
   * RunOptions.maxRetries. See src/runtime/retry.ts.
   *
   * 针对瞬时（error_during_execution）失败的、按 agent 覆盖的重试预算。设为 0 可对该 agent
   * 关闭重试；对已知不稳的节点可调高。覆盖 RunOptions.maxRetries。见 src/runtime/retry.ts。
   */
  retries?: number;
}

// ────────────────────────────────────────────────────────────────────────────
// hooks injected into the script scope
// 注入到脚本作用域里的 hook
// ────────────────────────────────────────────────────────────────────────────

export type AgentFn = (prompt: string, opts?: AgentOptions) => Promise<unknown>;

export type Thunk<T = unknown> = () => Promise<T>;
export type ParallelFn = (thunks: ReadonlyArray<Thunk>) => Promise<Array<unknown>>;

/** A pipeline stage: receives the previous stage's result, the original item, and index. */
/** 一个 pipeline 阶段：接收上一阶段的结果、原始 item 以及索引。 */
export type PipelineStage = (
  prev: unknown,
  original: unknown,
  index: number,
) => Promise<unknown> | unknown;
export type PipelineFn = (
  items: ReadonlyArray<unknown>,
  ...stages: PipelineStage[]
) => Promise<Array<unknown>>;

export type PhaseFn = (title: string) => void;
export type LogFn = (message: string) => void;

export type WorkflowRef = string | { scriptPath: string };
export type WorkflowFn = (ref: WorkflowRef, args?: unknown) => Promise<unknown>;

/** The full set of globals bound into the workflow script's vm context. */
/** 绑定到 workflow 脚本 vm 上下文里的全部全局变量。 */
export interface ScriptHooks {
  agent: AgentFn;
  parallel: ParallelFn;
  pipeline: PipelineFn;
  phase: PhaseFn;
  log: LogFn;
  args: unknown;
  workflow: WorkflowFn;
}

// ────────────────────────────────────────────────────────────────────────────
// executor (claude --print subprocess)
// executor（claude --print 子进程）
// ────────────────────────────────────────────────────────────────────────────

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ExecOptions {
  prompt: string;
  cwd: string;
  model?: string;
  reasoningEffort?: string;
  schema?: JsonSchema;
  appendSystemPrompt?: string;
  resumeSessionId?: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  env?: Record<string, string>;
  /** Path to write the raw stream-json trace for debugging. */
  /** 写入原始 stream-json trace 的路径，用于调试。 */
  tracePath?: string;
  signal?: AbortSignal;
}

export type ResultSubtype =
  | "success"
  | "error_max_turns"
  | "error_max_structured_output_retries"
  | "error_during_execution"
  | "timeout"
  | "idle_timeout"
  | (string & {});

export interface ExecResult {
  text: string;
  structuredOutput?: unknown;
  sessionId: string | null;
  costUsd: number;
  durationMs: number;
  resultSubtype: ResultSubtype;
  isError: boolean;
  usage: TokenUsage;
  /** Whether usage/session values came from a verified machine-readable source. */
  telemetryAvailable?: boolean;
}

/** The executor function signature; the only thing that touches `claude`. */
/** executor 函数签名；唯一直接接触 `claude` 的东西。 */
export type Executor = (opts: ExecOptions) => Promise<ExecResult>;

// ────────────────────────────────────────────────────────────────────────────
// progress events
// 进度事件
// ────────────────────────────────────────────────────────────────────────────

export type ProgressEvent =
  | { type: "run_start"; runId: string; meta: WorkflowMeta; ts: string }
  | { type: "phase_start"; phase: string; ts: string }
  | {
      type: "agent_start";
      agentId: number;
      label: string;
      phase: string | null;
      cached: boolean;
      ts: string;
    }
  | {
      type: "agent_end";
      agentId: number;
      label: string;
      phase: string | null;
      ok: boolean;
      cached: boolean;
      /** true when the agent was cancelled (run aborted) rather than failing on its own. */
      /** 当 agent 是被取消（run 中止）而非自身失败时为 true。 */
      skipped?: boolean;
      costUsd: number;
      outputTokens: number;
      durationMs: number;
      error?: string;
      ts: string;
    }
  | { type: "log"; message: string; phase: string | null; ts: string }
  | { type: "workflow_start"; name: string; ts: string }
  | { type: "workflow_end"; name: string; ok: boolean; ts: string }
  | {
      type: "run_end";
      runId: string;
      ok: boolean;
      tokensSpent: number;
      durationMs: number;
      ts: string;
      // Advisory per-agent/workflow failure counts (Bug 2): `ok` reflects whether the script
      // completed and returned a value, so a fault-tolerant workflow that swallows an agent
      // failure via parallel()→null can still be ok:true. These counts let consumers report
      // "ok (N failed)" rather than hiding the partial failures. 0 when the script threw.
      // 通告性的 per-agent/workflow 失败计数（Bug 2）：`ok` 反映脚本是否完成并返回了值，
      // 因此通过 parallel()→null 吞掉 agent 失败的容错型 workflow 仍可为 ok:true。
      // 这些计数让消费方能报告 "ok (N failed)"，而不是隐藏部分失败。脚本抛出时为 0。
      failedAgents?: number;
      failedWorkflows?: number;
    };

export type EventSink = (event: ProgressEvent) => void;

// ────────────────────────────────────────────────────────────────────────────
// journal (resume / caching)
// journal（恢复 / 缓存）
// ────────────────────────────────────────────────────────────────────────────

export interface AgentRecord {
  index: number;
  /** sha256(prompt + stableStringify(opts)). */
  /** sha256(prompt + stableStringify(opts))。 */
  key: string;
  label: string;
  phase: string | null;
  /** The resolved agent() return value (string | object | null). */
  /** agent() 解析后的返回值（string | object | null）。 */
  result: unknown;
  cached: boolean;
  outputTokens: number;
  ts: string;
}

// ────────────────────────────────────────────────────────────────────────────
// public entry API
// 公开的入口 API
// ────────────────────────────────────────────────────────────────────────────

export interface RunOptions {
  script?: string;
  scriptPath?: string;
  name?: string;
  args?: unknown;
  resumeFromRunId?: string;
  cwd?: string;
  model?: string;
  runDir?: string;
  concurrency?: number;
  onEvent?: EventSink;
  registryDir?: string;
  /** Required named registry of executors. Each agent() picks one by key via AgentOptions.executor; missing/unknown throws. */
  /** 必填的命名 executor 注册表。每个 agent() 通过 AgentOptions.executor 按 key 选用；缺失/未知则 throw。 */
  executors: Record<string, Executor>;
  /**
   * Optional host-supplied default registry key used when agent() omits executor.
   * Unset means fail-fast (INVARIANT #10). The Grok-hosted plugin sets this to "zcode".
   * 可选的 host 默认注册表 key：agent() 省略 executor 时使用。未设置则 fail-fast（不变量 #10）。
   * Grok 托管的插件把它设为 "zcode"。
   */
  defaultExecutor?: string;
  /** Per-agent default timeout. */
  /** 每个 agent 的默认超时。 */
  agentTimeoutMs?: number;
  /**
   * Run-wide default for transient-failure retries. When an agent's executor returns
   * `error_during_execution` (a transient CLI crash / "Turn execution failed" / network blip), the
   * runtime retries up to this many EXTRA attempts with exponential backoff before giving up.
   * Permanent failures (schema validation, exhausted turn budget) are never retried. Default 2.
   * Per-agent override: AgentOptions.retries. See src/runtime/retry.ts.
   *
   * 瞬时失败重试的运行级默认值。当某个 agent 的 executor 返回 error_during_execution（瞬时 CLI
   * 崩溃 / "Turn execution failed" / 网络抖动）时，运行时最多再额外重试这么多次（指数退避）后放弃。
   * 永久性失败（schema 校验、轮数耗尽）永不重试。默认 2。按 agent 覆盖：AgentOptions.retries。
   * 见 src/runtime/retry.ts。
   */
  maxRetries?: number;
  /** Base delay (ms) for retry backoff; attempt N waits `baseMs * 2^(N-1)` capped at 8×. Default 1000. */
  /** 重试退避的基础延迟（毫秒）；第 N 次尝试等待 `baseMs * 2^(N-1)`，上限 8×。默认 1000。 */
  retryBackoffMs?: number;
  /**
   * External cancellation. When it aborts, in-flight agent subprocesses are killed
   * 外部取消。当它中止时，正在执行的 agent 子进程会被杀掉
   * (process-group SIGKILL) and the run unwinds: parallel()/pipeline() re-throw instead
   * （进程组 SIGKILL），整个 run 随之回退：parallel()/pipeline() 会重新抛出而不是
   * of swallowing to null, so runWorkflow() rejects. Already-completed agents stay
   * 吞掉成 null，于是 runWorkflow() 会 reject。已经完成的 agent 仍保留
   * recorded in the journal, so a later resumeFromRunId replays them with zero spend.
   * 在 journal 里，所以之后的 resumeFromRunId 会零开销地重放它们。
   */
  signal?: AbortSignal;
}

export interface WorkflowResult {
  runId: string;
  scriptPath: string;
  meta: WorkflowMeta;
  /** Whatever the script returned (or undefined). */
  /** 脚本返回的任意值（或 undefined）。 */
  value: unknown;
  events: ProgressEvent[];
  tokensSpent: number;
  agentCount: number;
  durationMs: number;
  /** True only when the run completed without failed agent or workflow events. */
  ok: boolean;
  /** Number of failed agent_end events, including failures swallowed by parallel(). */
  failedAgents: number;
  /** Number of failed nested workflow_end events. */
  failedWorkflows: number;
  /** False when any required journal write failed. */
  durable: boolean;
  /** Journal write diagnostics, safe to expose without credentials. */
  journalErrors: string[];
}

// ────────────────────────────────────────────────────────────────────────────
// internal shared run context (passed to hooks by run.ts)
// 内部共享的 run 上下文（由 run.ts 传给各 hook）
// ────────────────────────────────────────────────────────────────────────────

export interface RunContext {
  runId: string;
  runDir: string;
  cwd: string;
  defaultModel?: string;
  registryDir?: string;
  /** Named executor registry; agent() resolves AgentOptions.executor against this map. */
  /** 命名 executor 注册表；agent() 用 AgentOptions.executor 对照此 map 解析。 */
  executors: Record<string, Executor>;
  /** Host-supplied default executor name; unset keeps the fail-fast "executor required" rule. */
  /** host 提供的默认 executor 名；未设置则保持 fail-fast「必须指定 executor」规则。 */
  defaultExecutor?: string;
  agentTimeoutMs?: number;
  /** Run-wide default retry budget for transient (error_during_execution) failures. */
  /** 瞬时（error_during_execution）失败的运行级默认重试预算。 */
  maxRetries?: number;
  /** Base delay (ms) for retry backoff. */
  /** 重试退避的基础延迟（毫秒）。 */
  retryBackoffMs?: number;
  /** Concurrency cap. */
  /** 并发上限。 */
  concurrency: number;
  /** Nesting depth (0 = top-level; >0 forbids further workflow()). */
  /** 嵌套深度（0 = 顶层；>0 则禁止再调用 workflow()）。 */
  depth: number;
  emit: EventSink;
  abort: AbortSignal;
  /** Current phase() cursor (mutable). */
  /** 当前 phase() 游标（可变）。 */
  currentPhase: { value: string | null };
  /** Monotonic agent id allocator + 1000 cap enforcement. */
  /** 单调递增的 agent id 分配器 + 强制 1000 上限。 */
  nextAgentId(): number;
  /** Record an agent admission failure that occurred before an id/event existed. */
  /** 记录在分配 id/事件之前发生的 agent 准入失败。 */
  noteAgentFailure(): void;
  /** Resume cache lookup by content key; returns the cached record or undefined. */
  /** 按内容 key 查找恢复缓存；返回缓存的 record 或 undefined。 */
  takeCached(key: string): AgentRecord | undefined;
  /** Append a freshly-produced (or cache-confirmed) record to the journal. */
  /** 把新产生（或缓存确认）的 record 追加到 journal。 */
  record(rec: AgentRecord): void;
  /** Accumulate output tokens for the run's tokensSpent metric (observability only; no ceiling). */
  /** 累加输出 token 用于本次 run 的 tokensSpent 观测指标（仅观测，无上限）。 */
  addTokens(n: number): void;
}

export const TOTAL_AGENT_CAP = 1000;
