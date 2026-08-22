// runtime/retry.ts — transient-failure classification + backoff for agent() executor calls.
// runtime/retry.ts —— agent() executor 调用的「瞬时失败」分类 + 退避。
//
// Every model CLI occasionally fails a turn for reasons that are NOT the model's reasoning:
// a transient API rate-limit, a network blip, an "Turn execution failed" runtime error, a crash
// with exit code 1. These are worth a bounded retry — the next attempt usually succeeds — whereas
// a schema-validation failure or an exhausted-turn-budget is permanent and should not be retried.
// This module owns the classification (is this ExecResult retriable?) and the backoff schedule.
//
// 每个模型 CLI 偶尔会因为「非模型推理」的原因失败一轮：瞬时的 API 限流、网络抖动、"Turn
// execution failed" 运行时错误、退出码 1 的崩溃。这些值得有限次重试——下一次通常成功——而
// schema 校验失败或轮数耗尽是永久性的，不该重试。本模块负责分类（这个 ExecResult 可重试吗？）
// 与退避调度。

import type { ExecResult, ResultSubtype } from "../types.js";

/**
 * Default retry budget. A transient failure gets up to this many EXTRA attempts (so the total
 * attempt count is 1 + maxRetries). Chosen so a genuinely transient blip is absorbed (1–2 retries
 * almost always suffices) while a permanent error that happens to carry the retriable subtype
 * (e.g. "binary not found" — also `error_during_execution`) fails fast rather than hammering.
 *
 * 默认重试预算。一次瞬时失败最多获得这么多次【额外】尝试（故总尝试数 = 1 + maxRetries）。
 * 取值使得真正的瞬时抖动被吸收（1–2 次重试几乎总够），而恰好带可重试 subtype 的永久错误
 *（如 "binary not found"——同样是 error_during_execution）也能快速失败而非猛砸。
 */
export const DEFAULT_MAX_RETRIES = 2;

/**
 * Base delay for exponential backoff: attempt N (1-indexed) waits `baseMs * 2^(N-1)` before
 * retrying, capped at 8× the base. Deterministic (no Math.random) so behavior is predictable and
 * sandbox-safe; the workflow concurrency cap limits any thundering-herd concern.
 *
 * 指数退避的基础延迟：第 N 次（从 1 起）尝试在重试前等待 `baseMs * 2^(N-1)`，上限为 8× 基础值。
 * 确定性（无 Math.random），故行为可预测且沙箱安全；workflow 的并发上限已限制雷群效应。
 */
export const DEFAULT_RETRY_BACKOFF_MS = 1000;

const MAX_BACKOFF_MULTIPLE = 8;

/**
 * The set of result subtypes worth retrying. Only `error_during_execution`: it is what every
 * adapter sets when the CLI ran but the turn itself errored (exit≠0, stream error, spawn error,
 * "Turn execution failed") — exactly the transient infrastructure failures a retry can fix. The
 * other subtypes are permanent by construction:
 *  - error_max_turns / error_max_structured_output_retries: the CLI already exhausted its own
 *    budget; retrying repeats the same exhausted work.
 *  - timeout / idle_timeout: retrying a wall/idle timeout is expensive and usually futile
 *    (the work takes too long; it will again). Default: don't retry; can be revisited via config.
 *  - success: nothing to retry.
 *
 * 值得重试的 result subtype 集合。仅 error_during_execution：它是每个 adapter 在「CLI 跑了但
 * 这一轮本身出错」（exit≠0、流错误、spawn 错误、"Turn execution failed"）时设置的——正是重试
 * 能解决的瞬时基础设施故障。其余 subtype 按构造即是永久性的：error_max_turns /
 * error_max_structured_output_retries（CLI 已耗尽自身预算，重试只是重复同样的耗尽）；timeout /
 * idle_timeout（重试墙钟/idle 超时既昂贵又通常徒劳——活儿就是太慢，再来一次也一样；默认不重试，
 * 可通过配置再议）；success（无需重试）。
 */
const RETRIABLE_SUBTYPES: ReadonlySet<ResultSubtype> = new Set(["error_during_execution"]);

/**
 * Should this ExecResult be retried? True only when the executor flagged an error AND the subtype
 * is one of the transient, infrastructure-class failures. A success result, a schema failure
 * (which throws before reaching the retry decision), or an exhausted-turns result all return false.
 * Pure — safe to unit-test with no I/O.
 *
 * 该 ExecResult 是否应重试？仅在 executor 标记了错误、且 subtype 属于瞬时基础设施类失败时为真。
 * 成功结果、schema 失败（在到达重试决策前就已抛出）、轮数耗尽结果都返回 false。纯函数——无 I/O，
 * 可直接单测。
 */
export function isRetriable(res: ExecResult): boolean {
  return res.isError && RETRIABLE_SUBTYPES.has(res.resultSubtype);
}

/**
 * Compute the backoff delay (ms) before attempt `attempt` (1-indexed: attempt 1 is the FIRST retry
 * after the initial failure). Returns baseMs * 2^(attempt-1), capped at 8× baseMs. Deterministic.
 * `attempt <= 0` returns 0 (no delay before the initial call). Pure.
 *
 * 计算第 `attempt` 次（从 1 起：attempt 1 是初始失败后的【第一次】重试）尝试前的退避延迟（毫秒）。
 * 返回 baseMs * 2^(attempt-1)，上限 8× baseMs。确定性。attempt <= 0 返回 0（初始调用前无延迟）。纯函数。
 */
export function backoffDelayMs(attempt: number, baseMs = DEFAULT_RETRY_BACKOFF_MS): number {
  if (attempt <= 0) return 0;
  const multiple = Math.min(2 ** (attempt - 1), MAX_BACKOFF_MULTIPLE);
  return baseMs * multiple;
}

/**
 * Sleep that resolves after `ms` milliseconds, but rejects early (as an AbortError) if `signal`
 * aborts first — so a cancelled run does not sleep through its own cancellation. The rejection lets
 * the retry loop unwind into the normal abort path rather than completing a pointless backoff.
 *
 * 在 `ms` 毫秒后 resolve 的 sleep，但如果 `signal` 先 abort 则提前 reject（抛 AbortError）——
 * 这样被取消的 run 不会熬完自己的取消延迟。该 reject 让重试循环回退到正常的 abort 路径，
 * 而非完成一次毫无意义的退避。
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new AbortError("aborted"));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AbortError("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Error subclass used so an abort-during-backoff is distinguishable from a real executor failure
 * (the run is cancelling, not failing). Mirrors how subprocess.ts rejects abort as a distinct path.
 *
 * 错误子类，使「退避期间 abort」可与真实的 executor 失败区分（run 是在取消，不是在失败）。
 * 对应 subprocess.ts 把 abort 作为独立路径 reject 的做法。
 */
export class AbortError extends Error {
  override readonly name = "AbortError";
}
