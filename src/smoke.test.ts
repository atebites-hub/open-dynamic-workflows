// smoke.test.ts — end-to-end proof that the workflow runtime works WITHOUT spending real
// smoke.test.ts —— 端到端验证 workflow runtime 能跑通，且不消耗真实的
// claude tokens. We inject FAKE Executors via the required RunOptions.executors map, and every
// claude token。我们通过必填的 RunOptions.executors map 注入 FAKE Executor，且每个
// agent() call names one with {executor:'...'}, so no `claude --print` subprocess is ever
// agent() 调用都用 {executor:'...'} 指名一个，因此永远不会 spawn `claude --print`
// spawned. Each test pins a unique runDir to avoid journal clashes.
// 子进程。每个测试固定一个唯一的 runDir，以避免 journal 冲突。
//
// Run: npx tsx --test src/smoke.test.ts
// 运行：npx tsx --test src/smoke.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

import { runWorkflow } from "./runtime/run.js";
import type { Executor, ExecOptions, ExecResult, ProgressEvent, RunOptions } from "./types.js";

// ────────────────────────────────────────────────────────────────────────────
// Fake executor (per task spec). Resolves instantly; never touches `claude`.
// 伪造的 executor（按任务规格）。立即 resolve；永远不碰 `claude`。
// ────────────────────────────────────────────────────────────────────────────

function makeFakeResult(opts: ExecOptions): ExecResult {
  return {
    text: "FAKE:" + opts.prompt.slice(0, 20),
    structuredOutput: opts.schema ? { ok: true } : undefined,
    sessionId: "fake",
    costUsd: 0,
    durationMs: 1,
    resultSubtype: "success",
    isError: false,
    usage: { inputTokens: 1, outputTokens: 5 },
  };
}

const fakeExecutor: Executor = async (opts) => makeFakeResult(opts);

// Test scratch lives in the OS temp dir — never pollutes the repo.
// 测试 scratch 放 OS 临时目录 —— 绝不污染仓库。
const RUNS_ROOT = path.join(os.tmpdir(), "odw-smoke-runs");

let dirSeq = 0;
/** A unique runDir under the temp dir for each test, so journals never collide. */
/** 为每个测试在临时目录下生成一个唯一的 runDir，使 journal 永不冲突。 */
function uniqueRunDir(tag: string): string {
  dirSeq += 1;
  return path.join(RUNS_ROOT, `smoke-${tag}-${dirSeq}`);
}

/** Base RunOptions with the fake executor registered as 'fake'; per-test runDir + script. */
/** 把 fake executor 注册为 'fake' 的基础 RunOptions；带每个测试各自的 runDir + script。 */
function opts(tag: string, script: string, extra: Partial<RunOptions> = {}): RunOptions {
  return {
    script,
    executors: { fake: fakeExecutor },
    runDir: uniqueRunDir(tag),
    ...extra,
  };
}

const META = `export const meta = { name: 'smoke', description: 'smoke test workflow' }\n`;

// ────────────────────────────────────────────────────────────────────────────
// (a) phase()/log()/agent() — script value returned; agent() text = "FAKE:..."
// (a) phase()/log()/agent() —— 返回 script 的返回值；agent() 的 text = "FAKE:..."
// ────────────────────────────────────────────────────────────────────────────

test("(a) script with phase/log/agent returns its value; agent() text is FAKE:prompt", async () => {
  const script = `${META}
phase('Scan');
log('starting');
const t = await agent('hello world prompt for the agent', { executor: 'fake' });
return { text: t };
`;
  const res = await runWorkflow(opts("a", script));
  assert.equal(typeof res.value, "object");
  const value = res.value as { text: string };
  // "FAKE:" + first 20 chars of the prompt.
  // "FAKE:" + prompt 的前 20 个字符。
  assert.equal(value.text, "FAKE:hello world prompt f");
  assert.ok(value.text.startsWith("FAKE:"));
});

// ────────────────────────────────────────────────────────────────────────────
// (b) agent() with schema returns the validated structured object { ok: true }
// (b) 带 schema 的 agent() 返回经校验的结构化对象 { ok: true }
// ────────────────────────────────────────────────────────────────────────────

test("worktree isolation creates a separate checkout for a mutating agent", async () => {
  const runDir = uniqueRunDir("worktree");
  let executorCwd = "";
  const executor: Executor = async (execOpts) => {
    executorCwd = execOpts.cwd ?? "";
    return makeFakeResult(execOpts);
  };
  const script = `${META}
const value = await agent('inspect the current checkout path and report it', { executor: 'fake', isolation: 'worktree' });
return value;
`;
  await runWorkflow({ ...opts("worktree", script), runDir, executors: { fake: executor } });
  assert.notEqual(executorCwd, process.cwd());
  assert.match(executorCwd, /worktrees[\\/]agent-1$/);

  const listed = execFileSync("git", ["worktree", "list", "--porcelain"], { encoding: "utf8" });
  assert.doesNotMatch(listed, new RegExp(executorCwd.replace(/[.*+?^${}()|[\]\\\\]/g, "\\\\$&")));
});

test("(b) agent() with schema returns the structured object { ok: true }", async () => {
  const script = `${META}
const obj = await agent('give me structured output', {
  executor: 'fake',
  schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
});
return obj;
`;
  const res = await runWorkflow(opts("b", script));
  assert.deepEqual(res.value, { ok: true });
});

// ────────────────────────────────────────────────────────────────────────────
// (c) parallel([ok, throwing]) → [value, null]; call never rejects, order kept
// (c) parallel([ok, throwing]) → [value, null]；调用永不 reject，顺序保持不变
// ────────────────────────────────────────────────────────────────────────────

test("(c) parallel([ok, throwing]) resolves to [value, null]", async () => {
  const script = `${META}
const out = await parallel([
  async () => await agent('the good one', { executor: 'fake' }),
  async () => { throw new Error('boom'); },
]);
return out;
`;
  const res = await runWorkflow(opts("c", script));
  const out = res.value as unknown[];
  assert.equal(out.length, 2);
  assert.equal(out[0], "FAKE:the good one");
  assert.equal(out[1], null);
});

// ────────────────────────────────────────────────────────────────────────────
// (c2) Bug 2: a workflow that swallows a failed agent (parallel()→null + filter)
//      and returns a value is OK — failedAgents is advisory, not run-fatal. Before the fix,
//      any agent_end{ok:false} flipped run `ok` to false and the CLI exited 1 despite a
//      usable result.
// (c2) Bug 2：吞掉失败 agent（parallel()→null + 过滤）并返回值的 workflow 是 OK 的
//      —— failedAgents 是通告性的，不让整个 run 失败。修复前，任何 agent_end{ok:false}
//      都会把 run 的 `ok` 翻成 false，CLI 以 1 退出，尽管结果可用。
// ────────────────────────────────────────────────────────────────────────────

test("(c2) Bug 2: a swallowed agent failure leaves the run ok:true with failedAgents:1", async () => {
  const script = `${META}
// One agent throws an ExecResult isError (the real failure path the runtime sees),
// parallel() resolves it to null, the script filters and returns a value.
const out = await parallel([
  async () => await agent('the good one', { executor: 'fake' }),
  async () => await agent('boom', { executor: 'failing' }),
]);
return out.filter(Boolean);
`;
  // A second executor that returns an error ExecResult (mirrors what hooks.ts treats as a
  // failed agent: res.isError && resultSubtype !== "success" → throws inside agent()).
  // 第二个 executor 返回一个 isError 的 ExecResult（对应 hooks.ts 视作失败 agent 的路径：
  // res.isError && resultSubtype !== "success" → 在 agent() 内抛出）。
  const failing: Executor = async () => ({
    text: "",
    sessionId: null,
    costUsd: 0,
    durationMs: 1,
    resultSubtype: "error_during_execution",
    isError: true,
    usage: { inputTokens: 0, outputTokens: 0 },
  });
  const res = await runWorkflow({
    ...opts("c2", script),
    executors: { fake: fakeExecutor, failing },
    maxRetries: 0,
  });

  // The script returned a filtered array with just the good agent's value.
  // 脚本返回了过滤后的数组，只含成功 agent 的值。
  const value = res.value as unknown[];
  assert.deepEqual(value, ["FAKE:the good one"]);
  // Bug 2: the run SUCCEEDED (returned a value) despite one agent failing.
  // Bug 2：尽管有一个 agent 失败，run 仍然成功（返回了值）。
  assert.equal(res.ok, true);
  assert.equal(res.failedAgents, 1);
  // The run_end event carries the advisory counts so labels can show "ok (1 failed)".
  // run_end 事件携带通告性计数，使标签能显示 "ok (1 failed)"。
  const runEnd = res.events.find((e) => e.type === "run_end");
  assert.equal(runEnd?.type === "run_end" ? runEnd.failedAgents : undefined, 1);
});

// ────────────────────────────────────────────────────────────────────────────
// (d) pipeline([1,2,3], s1, s2) maps correctly; a throwing stage → null at that
// (d) pipeline([1,2,3], s1, s2) 正确映射；某个阶段抛错 → 该位置变为 null，
//     position while the other items still succeed.
//     而其他 item 仍然成功。
// ────────────────────────────────────────────────────────────────────────────

test("(d) pipeline maps (prev,original,index) and drops a throwing item to null", async () => {
  const script = `${META}
const out = await pipeline(
  [1, 2, 3],
  async (prev, original, index) => {
    // s1 receives the original item as prev for the first stage.
    // 第一阶段 s1 收到的 prev 就是原始 item。
    if (prev !== original) throw new Error('stage1 prev should equal original');
    if (original === 2) throw new Error('blow up item 2 in stage 1');
    return prev * 10 + index;     // 1->10+0=10 ; 3->30+2=32 ｜ 1->10+0=10 ; 3->30+2=32
  },
  async (prev) => prev + 1,        // 10->11 ; 32->33 ｜ 10->11 ; 32->33
);
return out;
`;
  const res = await runWorkflow(opts("d", script));
  // item 1: (1*10+0)+1 = 11 ; item 2: thrown in stage 1 -> null ; item 3: (3*10+2)+1 = 33
  // item 1: (1*10+0)+1 = 11 ; item 2: 在阶段 1 抛错 -> null ; item 3: (3*10+2)+1 = 33
  assert.deepEqual(res.value, [11, null, 33]);
});

// ────────────────────────────────────────────────────────────────────────────
// (f) sandbox determinism traps (SPEC §6): Date.now() and Math.random() throw
// (f) 沙箱确定性陷阱（SPEC §6）：Date.now() 和 Math.random() 在 script 内部
//     inside the script → runWorkflow rejects.
//     抛错 → runWorkflow reject。
// ────────────────────────────────────────────────────────────────────────────

test("(f) wall-clock-now API (Date.now) makes the run reject", async () => {
  const script = `${META}
const t = Date.now();
return t;
`;
  await assert.rejects(runWorkflow(opts("f-date", script)));
});

test("(f) randomness API (Math.random) makes the run reject", async () => {
  const script = `${META}
const r = Math.random();
return r;
`;
  await assert.rejects(runWorkflow(opts("f-rand", script)));
});

test("(f) argless new Date() is rejected by the static determinism scan", async () => {
  await assert.rejects(
    runWorkflow(opts("f-newdate", `${META}\nreturn new Date();\n`)),
    /deterministic/i,
  );
});

test("(f) argless Intl.DateTimeFormat().format() is trapped (no ambient wall-clock leak)", async () => {
  // ECMA-402 defaults a missing/undefined date arg to the system clock in engine C++,
  // ECMA-402 在引擎 C++ 层会把缺失/undefined 的 date 参数默认为系统时钟，
  // bypassing the SafeDate override — must be trapped at the Intl layer.
  // 从而绕过 SafeDate 覆盖 —— 必须在 Intl 层加以拦截。
  await assert.rejects(
    runWorkflow(opts("f-intl-fmt", `${META}\nreturn Intl.DateTimeFormat().format();\n`)),
  );
  await assert.rejects(
    runWorkflow(opts("f-intl-parts", `${META}\nreturn Intl.DateTimeFormat().formatToParts();\n`)),
  );
  await assert.rejects(
    runWorkflow(opts("f-intl-undef", `${META}\nreturn Intl.DateTimeFormat().format(undefined);\n`)),
  );
});

test("(f) explicit Intl.DateTimeFormat().format(ts) + NumberFormat still work", async () => {
  const script = `${META}
const d = Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(0);
const n = Intl.NumberFormat('en-US').format(1234.5);
return { d, n };
`;
  const res = await runWorkflow(opts("f-intl-ok", script));
  const v = res.value as { d: string; n: string };
  assert.equal(v.d, "01/01/1970");
  assert.equal(v.n, "1,234.5");
});

test("(f) Intl formatRange: explicit args work (this bound), argless trapped", async () => {
  const ok = `${META}
return Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).formatRange(0, 86400000);
`;
  const res = await runWorkflow(opts("f-intl-range", ok));
  assert.equal(typeof res.value, "string");
  assert.ok((res.value as string).includes("1970"));

  await assert.rejects(
    runWorkflow(opts("f-intl-range-argless", `${META}\nreturn Intl.DateTimeFormat().formatRange();\n`)),
  );
});

// ────────────────────────────────────────────────────────────────────────────
// (g) non-literal meta rejects (SPEC §3) — a meta that references a variable is
// (g) 非字面量的 meta 被拒（SPEC §3）—— 引用了变量的 meta
//     not a pure literal, so extractMeta throws and the run rejects.
//     不是纯字面量，因此 extractMeta 抛错，整个 run 被 reject。
// ────────────────────────────────────────────────────────────────────────────

test("(g) non-literal meta rejects", async () => {
  const nameVar = "computed-name";
  const script = `const n = ${JSON.stringify(nameVar)};
export const meta = { name: n, description: 'meta references a variable -> not a pure literal' }
return 'unreachable';
`;
  await assert.rejects(runWorkflow(opts("g", script)));
});

// ────────────────────────────────────────────────────────────────────────────
// (h) WorkflowResult shape: runId/value present; events include run_start,
// (h) WorkflowResult 的形状：runId/value 存在；events 包含 run_start、
//     agent_start, agent_end, run_end.
//     agent_start、agent_end、run_end。
// ────────────────────────────────────────────────────────────────────────────

test("(h2) concurrency queues 500 agents at the configured limit", async () => {
  let active = 0;
  let peak = 0;
  let completed = 0;
  const executor: Executor = async ({ prompt }) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1;
    completed += 1;
    return makeFakeResult({ prompt, cwd: "/tmp" });
  };
  const script = `${META}
const results = await parallel(Array.from({ length: 500 }, (_, i) => () => agent('queued ' + i, { executor: 'fake' })));
return results;
`;
  const res = await runWorkflow(opts("h2", script, { executors: { fake: executor }, concurrency: 6 }));

  assert.ok(Array.isArray(res.value));
  const values = res.value as unknown[];
  assert.equal(values.length, 500);
  assert.equal(values[0], "FAKE:queued 0");
  assert.equal(values[499], "FAKE:queued 499");
  assert.equal(res.agentCount, 500);
  assert.equal(res.ok, true);
  assert.equal(completed, 500);
  assert.equal(peak, 6);
});

test("(h) WorkflowResult shape + event lifecycle (run_start/agent_start/agent_end/run_end)", async () => {
  const script = `${META}
const t = await agent('one agent for the lifecycle', { executor: 'fake' });
return t;
`;
  const res = await runWorkflow(opts("h", script));

  assert.equal(typeof res.runId, "string");
  assert.ok(res.runId.length > 0);
  assert.equal(res.value, "FAKE:one agent for the li");
  assert.equal(res.ok, true);
  assert.equal(res.durable, true);
  assert.deepEqual(res.journalErrors, []);
  assert.ok(Array.isArray(res.events));

  const types = res.events.map((e) => e.type);
  assert.ok(types.includes("run_start"), "events should include run_start");
  assert.ok(types.includes("agent_start"), "events should include agent_start");
  assert.ok(types.includes("agent_end"), "events should include agent_end");
  assert.ok(types.includes("run_end"), "events should include run_end");

  // run_start first, run_end last; agent events sit between them.
  // run_start 在最前，run_end 在最后；agent 事件位于二者之间。
  assert.equal(types[0], "run_start");
  assert.equal(types[types.length - 1], "run_end");
});

// ────────────────────────────────────────────────────────────────────────────
// (i) sandbox Date trap is NOT escapable via an instance's .constructor (SPEC §6).
// (i) 沙箱的 Date 陷阱无法通过实例的 .constructor 逃逸（SPEC §6）。
//     `new Date(0).constructor.now()`, `Date.prototype.constructor.now()`, and the
//     `new Date(0).constructor.now()`、`Date.prototype.constructor.now()`，以及
//     argless `new (instance.constructor)()` all reach the trapped SafeDate, so the
//     无参的 `new (instance.constructor)()` 都会触达被拦截的 SafeDate，因此
//     run must reject — the determinism guarantee can't be defeated.
//     run 必须 reject —— 确定性保证无法被攻破。
// ────────────────────────────────────────────────────────────────────────────

test("(i) Date trap is not escapable via instance.constructor.now()", async () => {
  await assert.rejects(
    runWorkflow(opts("i-ctor-now", `${META}\nreturn new Date(0).constructor.now();\n`)),
  );
});

test("(i) Date trap is not escapable via Date.prototype.constructor.now()", async () => {
  await assert.rejects(
    runWorkflow(opts("i-proto-ctor", `${META}\nreturn Date.prototype.constructor.now();\n`)),
  );
});

test("(i) Date trap is not escapable via argless new (instance.constructor)()", async () => {
  await assert.rejects(
    runWorkflow(opts("i-ctor-new", `${META}\nconst C = new Date(0).constructor; return new C();\n`)),
  );
});

test("(i) Date trap is not escapable via structuredClone (host back-channel removed)", async () => {
  // structuredClone reconstructs Dates on the real untrapped prototype; it must not be
  // structuredClone 会在真实的、未被拦截的 prototype 上重建 Date 对象；因此它绝不能被
  // exposed, so referencing it inside the script throws (ReferenceError) → run rejects.
  // 暴露出来，所以在 script 内引用它会抛错（ReferenceError）→ run 被 reject。
  await assert.rejects(
    runWorkflow(opts("i-sclone", `${META}\nreturn structuredClone(new Date(0)).constructor.now();\n`)),
  );
  await assert.rejects(
    runWorkflow(opts("i-sclone-nested", `${META}\nreturn structuredClone({ d: new Date(5) }).d.constructor.now();\n`)),
  );
});

test("(i) explicit Date construction + parse still work (legit path not broken)", async () => {
  const script = `${META}
return {
  t: new Date(0).getTime(),
  iso: new Date(0).toISOString(),
  parsed: Date.parse('1970-01-01T00:00:00.000Z'),
};
`;
  const res = await runWorkflow(opts("i-legit", script));
  // NB: the script's returned object literal carries the vm context's Object.prototype,
  // 注意：script 返回的对象字面量携带的是 vm context 的 Object.prototype，
  // so assert.deepEqual (=deepStrictEqual, prototype-sensitive) would fail across realms.
  // 因此 assert.deepEqual（=deepStrictEqual，对 prototype 敏感）跨 realm 会失败。
  // Assert fields individually, like the other tests do.
  // 像其他测试那样逐个字段断言。
  const v = res.value as { t: number; iso: string; parsed: number };
  assert.equal(v.t, 0);
  assert.equal(v.iso, "1970-01-01T00:00:00.000Z");
  assert.equal(v.parsed, 0);
});

// ────────────────────────────────────────────────────────────────────────────
// (j) Every ProgressEvent is persisted to runDir/events.jsonl (SPEC §10), not just
// (j) 每个 ProgressEvent 都会持久化到 runDir/events.jsonl（SPEC §10），而不仅仅是
//     buffered in-memory / fanned to onEvent.
//     在内存中缓冲 / 分发给 onEvent。
// ────────────────────────────────────────────────────────────────────────────

test("(j) events.jsonl is appended to disk with the full lifecycle", async () => {
  const baseDir = uniqueRunDir("j");
  const script = `${META}\nphase('Scan');\nconst t = await agent('persist my events', { executor: 'fake' });\nreturn t;\n`;
  const res = await runWorkflow({ script, executors: { fake: fakeExecutor }, runDir: baseDir });

  const eventsPath = path.join(baseDir, res.runId, "events.jsonl");
  const raw = await readFile(eventsPath, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim() !== "");
  const types = lines.map((l) => (JSON.parse(l) as { type: string }).type);

  assert.ok(types.includes("run_start"), "events.jsonl should include run_start");
  assert.ok(types.includes("phase_start"), "events.jsonl should include phase_start");
  assert.ok(types.includes("agent_start"), "events.jsonl should include agent_start");
  assert.ok(types.includes("agent_end"), "events.jsonl should include agent_end");
  assert.ok(types.includes("run_end"), "events.jsonl should include run_end");
  // On-disk events match the in-memory events array length.
  // 磁盘上的 events 与内存中 events 数组的长度一致。
  assert.equal(lines.length, res.events.length);
});

// ────────────────────────────────────────────────────────────────────────────
// (k) resume: a second run against the same baseDir replays unchanged (prompt,opts)
// (k) resume：针对同一 baseDir 的第二次 run 会从 journal 重放那些 (prompt,opts) 未变的
//     agent() results from the journal — zero executor calls, zero token spend.
//     agent() 结果 —— 零次 executor 调用，零 token 消耗。
// ────────────────────────────────────────────────────────────────────────────

test("(k) resume replays cached agent results with zero spend on the second run", async () => {
  const baseDir = uniqueRunDir("k");
  let calls = 0;
  const countingExecutor: Executor = async (o) => {
    calls += 1;
    return makeFakeResult(o);
  };
  const script = `${META}\nconst a = await agent('first', { executor: 'fake' });\nconst b = await agent('second', { executor: 'fake' });\nreturn [a, b];\n`;

  const r1 = await runWorkflow({ script, executors: { fake: countingExecutor }, runDir: baseDir });
  assert.equal(calls, 2, "first run spawns both agents");
  assert.equal(r1.tokensSpent, 10, "first run spends 2 × 5 output tokens");
  assert.equal(r1.ok, true);
  assert.equal(r1.failedAgents, 0);

  const callsAfterFirst = calls;
  const r2 = await runWorkflow({
    script,
    executors: { fake: countingExecutor },
    runDir: baseDir,
    resumeFromRunId: r1.runId,
  });
  assert.equal(calls, callsAfterFirst, "resume makes NO new executor calls");
  assert.equal(r2.tokensSpent, 0, "resume spends zero tokens (full cache hit)");

  const v1 = r1.value as string[];
  const v2 = r2.value as string[];
  assert.equal(v2[0], v1[0]);
  assert.equal(v2[1], v1[1]);
});

// ────────────────────────────────────────────────────────────────────────────
// (l) cancellation: aborting RunOptions.signal mid-run kills in-flight agents, makes
// (l) 取消：在 run 进行中 abort RunOptions.signal 会杀掉在途的 agent，使
//     parallel() re-throw (run rejects), and surfaces a `skipped` agent_end event.
//     parallel() 重新抛错（run 被 reject），并产生一个标记为 `skipped` 的 agent_end 事件。
// ────────────────────────────────────────────────────────────────────────────

test("(l) RunOptions.signal aborts an in-flight run; parallel re-throws + emits skipped", async () => {
  const controller = new AbortController();
  // Resolves only after a long delay, but rejects promptly when its signal aborts —
  // 只在长时间延迟后才 resolve，但当其 signal abort 时会立即 reject ——
  // standing in for a real `claude --print` subprocess that gets SIGKILLed.
  // 用来模拟一个被 SIGKILL 掉的真实 `claude --print` 子进程。
  const slowExecutor: Executor = (o) =>
    new Promise<ExecResult>((resolve, reject) => {
      if (o.signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      const timer = setTimeout(() => resolve(makeFakeResult(o)), 5_000);
      o.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });

  const events: ProgressEvent[] = [];
  const script = `${META}\nreturn await parallel([() => agent('a', { executor: 'fake' }), () => agent('b', { executor: 'fake' })]);\n`;
  const p = runWorkflow({
    script,
    executors: { fake: slowExecutor },
    runDir: uniqueRunDir("l"),
    signal: controller.signal,
    onEvent: (e) => {
      events.push(e);
    },
  });

  setTimeout(() => controller.abort(), 50);

  await assert.rejects(p, /aborted/);
  assert.ok(
    events.some((e) => e.type === "agent_end" && e.skipped === true),
    "a cancelled agent emits agent_end{skipped:true}",
  );
});

// ────────────────────────────────────────────────────────────────────────────
// (m) per-node routing: with two distinguishable executors registered, each agent()
// (m) per-node 路由：注册两个可区分的 executor 后，每个 agent() 用
//     dispatches to the one named by its {executor} — the choice is per-call, not per-run.
//     自己的 {executor} 派发到对应那个 —— 选择是 per-call 的，不是 per-run。
// ────────────────────────────────────────────────────────────────────────────

test("(m) per-node {executor} routes each agent() to its named executor", async () => {
  // Two fakes with distinct text prefixes so we can prove which one handled each call.
  // 两个文本前缀不同的 fake，从而证明每次调用是被哪个处理的。
  const fakeA: Executor = async (o) => ({ ...makeFakeResult(o), text: "A:" + o.prompt });
  const fakeB: Executor = async (o) => ({ ...makeFakeResult(o), text: "B:" + o.prompt });

  const script = `${META}
const a = await agent('routed to a', { executor: 'a' });
const b = await agent('routed to b', { executor: 'b' });
return [a, b];
`;
  const res = await runWorkflow(
    opts("m", script, { executors: { a: fakeA, b: fakeB } }),
  );
  // Each call hit the executor named in its own options, not a single per-run default.
  // 每次调用都命中自己 options 里指名的 executor，而非单一的 per-run 默认值。
  // NB: the script's `return [a, b]` literal carries the vm context's Array.prototype, so a
  // direct deepStrictEqual against a host-realm literal fails on prototype identity (see test (i),
  // lines 321-325). Spread into a host-realm array to compare element values across realms.
  // 注意：脚本里 `return [a, b]` 字面量携带的是 vm context 的 Array.prototype，直接对宿主 realm 的字面量做
  // deepStrictEqual 会因 prototype 身份不一致而失败（见测试 (i)，321-325 行）。先 spread 成宿主 realm 的数组，
  // 再跨 realm 比较元素值。
  assert.deepEqual([...(res.value as unknown[])], ["A:routed to a", "B:routed to b"]);
});

// ────────────────────────────────────────────────────────────────────────────
// (n) missing executor: agent() with no {executor} → runWorkflow rejects (no default,
// (n) 缺 executor：agent() 不带 {executor} → runWorkflow reject（没有默认值，
//     fail fast). TS allows the call (opts is optional), so the runtime enforces it.
//     fail fast）。TS 允许这种调用（opts 可选），因此由运行时强制。
// ────────────────────────────────────────────────────────────────────────────

test("(n) agent() with no executor rejects the run (executor is required)", async () => {
  // No {executor} on the call at all — the registered 'fake' is never named.
  // 调用上完全没有 {executor} —— 注册的 'fake' 从未被指名。
  const script = `${META}\nreturn await agent('no executor named here');\n`;
  await assert.rejects(runWorkflow(opts("n", script)), /executor/i);
});

// ────────────────────────────────────────────────────────────────────────────
// (o) unknown executor name: {executor:'nope'} that isn't in the registry → rejects.
// (o) 未知 executor 名：{executor:'nope'} 不在注册表里 → reject。
// ────────────────────────────────────────────────────────────────────────────

test("(o) agent() naming an unregistered executor rejects the run", async () => {
  // 'fake' is registered (by opts()), but the call asks for 'nope', which is not.
  // 'fake' 已注册（由 opts() 提供），但调用要的是未注册的 'nope'。
  const script = `${META}\nreturn await agent('pick an unknown one', { executor: 'nope' });\n`;
  await assert.rejects(runWorkflow(opts("o", script)), /nope/);
});

// ────────────────────────────────────────────────────────────────────────────
// (p) executor-neutral replay (SPEC §9): the journal stores only the reduced result, so
// (p) executor 中立的重放（SPEC §9）：journal 只存归约后的结果，因此
//     resume replays from disk and NEVER invokes any executor. We prove it by resuming
//     resume 从磁盘重放，且绝不调用任何 executor。我们的证明方式：用一个
//     with an executor that throws on call — the resumed run still succeeds with zero spend.
//     一被调用就 throw 的 executor 来 resume —— 重放仍零开销地成功。
// ────────────────────────────────────────────────────────────────────────────

test("(p) resume is executor-neutral: replays from journal without invoking the executor", async () => {
  const baseDir = uniqueRunDir("p");
  const script = `${META}\nconst a = await agent('codex first', { executor: 'codex' });\nconst b = await agent('codex second', { executor: 'codex' });\nreturn [a, b];\n`;

  // First run: a normal fake registered under the name the script asks for ('codex').
  // 第一次 run：把一个普通 fake 注册成脚本所要的名字（'codex'）。
  const fakeCodex: Executor = async (o) => makeFakeResult(o);
  const r1 = await runWorkflow({ script, executors: { codex: fakeCodex }, runDir: baseDir });
  assert.equal(r1.tokensSpent, 10, "first run spends 2 × 5 output tokens");

  // Resume with an executor that throws if ever called. If replay touched the executor,
  // 用一个一旦被调用就 throw 的 executor 来 resume。如果重放碰了 executor，
  // the run would reject; instead it must replay the recorded results from the journal.
  // run 就会 reject；它必须改为从 journal 重放已记录的结果。
  let throwingCalls = 0;
  const throwingExecutor: Executor = async () => {
    throwingCalls += 1;
    throw new Error("executor must NOT be invoked during a journal replay");
  };
  const r2 = await runWorkflow({
    script,
    executors: { codex: throwingExecutor },
    runDir: baseDir,
    resumeFromRunId: r1.runId,
  });

  assert.equal(throwingCalls, 0, "resume invokes the executor zero times");
  assert.equal(r2.tokensSpent, 0, "resume spends zero tokens (full cache hit)");
  // Both runs return `[a, b]` literals built in their own vm realms, so each carries that
  // realm's Array.prototype — a direct deepStrictEqual fails on prototype identity (see test (i),
  // lines 321-325). Spread both into host-realm arrays to compare the replayed element values.
  // 两次 run 都返回各自 vm realm 里构造的 `[a, b]` 字面量，因而各自携带该 realm 的 Array.prototype——
  // 直接 deepStrictEqual 会因 prototype 身份不一致而失败（见测试 (i)，321-325 行）。把两边都 spread 成
  // 宿主 realm 的数组，再比较重放出的元素值。
  assert.deepEqual(
    [...(r2.value as unknown[])],
    [...(r1.value as unknown[])],
    "resume reproduces the first run's value verbatim",
  );
});

// ────────────────────────────────────────────────────────────────────────────
// (q) default on-disk layout (multi-script): each workflow is self-contained at
// (q) 默认磁盘布局（多脚本）：每个 workflow 自包含于 <cwd>/.odw/<slug>/——
//     <cwd>/.odw/<slug>/ — runs land under <slug>/runs/<runId>/, grouped by the
//     run 落在 <slug>/runs/<runId>/，按启动用的 --name 分组（脚本与它的 runs
//     --name used to launch, so a script and its runs stay in one folder.
//     收拢在同一文件夹）。
// ────────────────────────────────────────────────────────────────────────────

test("(q) default layout groups a run under .odw/<name>/runs/<runId>", async () => {
  // A throwaway project cwd with one authored workflow at .odw/<name>/script.js.
  // 一个临时项目 cwd，里面有一个撰写好的 workflow：.odw/<name>/script.js。
  const cwd = await mkdtemp(path.join(os.tmpdir(), "odw-layout-"));
  const name = "demo-flow";
  await mkdir(path.join(cwd, ".odw", name), { recursive: true });
  await writeFile(
    path.join(cwd, ".odw", name, "script.js"),
    `${META}\nconst t = await agent('hi', { executor: 'fake' });\nreturn t;\n`,
  );

  // Launch by name with no runDir override → the default slug-grouped layout applies.
  // slug = the --name used to launch (here 'demo-flow'), even though meta.name is 'smoke'.
  // 用 name 启动且不覆盖 runDir → 走默认的按 slug 分组布局。slug = 启动用的 --name
  //（这里是 'demo-flow'），即便 meta.name 是 'smoke'。
  const res = await runWorkflow({ name, cwd, executors: { fake: fakeExecutor } });

  const runDir = path.join(cwd, ".odw", name, "runs", res.runId);
  const journal = await readFile(path.join(runDir, "journal.jsonl"), "utf8");
  assert.ok(journal.trim().length > 0, "journal.jsonl lives under .odw/<name>/runs/<runId>/");
  assert.equal(res.value, "FAKE:hi");
});

// ────────────────────────────────────────────────────────────────────────────
// (r) a failing agent surfaces the executor's REASON (res.text), not just the subtype —
// (r) 失败的 agent 要冒泡出执行器给的【原因】(res.text)，而不只是 subtype ——
//     so a usage-limit / auth death reads as a real message in the error + agent_end.
//     这样配额/认证导致的失败在 error 和 agent_end 里都是一句真实消息。
// ────────────────────────────────────────────────────────────────────────────

test("(s2) agent cap failures are advisory when the script swallows them (Bug 2)", async () => {
  // 1001 agents with a concurrency cap of 6 → the overflow is refused (admission failure), the
  // script filters past the null and returns a count. The run COMPLETED and returned a value, so
  // Bug 2: ok is true; the 1 admission failure is surfaced as failedAgents advisory metadata.
  // 1001 个 agent、并发上限 6 → 超出的被拒（准入失败），脚本过滤掉 null 并返回计数。
  // run 完成并返回了值，故 Bug 2：ok 为 true；那 1 个准入失败作为 failedAgents 通告性元数据带出。
  const script = `${META}
return (await parallel(Array.from({ length: 1001 }, (_, i) => () => agent('cap ' + i, { executor: 'fake' })))).filter(Boolean).length;
`;
  const res = await runWorkflow(opts("s2", script, { executors: { fake: fakeExecutor }, concurrency: 6 }));
  assert.equal(res.ok, true);
  assert.equal(res.failedAgents, 1);
  assert.equal(res.agentCount, 1000);
});

test("(s) swallowed parallel failures are advisory, not run-fatal (Bug 2)", async () => {
  // A failing executor inside parallel() resolves to null; the script returns [null] and thus
  // completes. Bug 2: ok is true with failedAgents:1 (previously this was ok:false — a usable
  // return value was mislabeled "failed" because one agent errored).
  // 失败的 executor 在 parallel() 内 resolve 成 null；脚本返回 [null]，因此完成。
  // Bug 2：ok 为 true、failedAgents:1（此前为 ok:false —— 仅仅因为一个 agent 出错，就把可用的
  // 返回值误标成 "failed"）。
  const failing: Executor = async () => ({
    text: "boom",
    sessionId: null,
    costUsd: 0,
    durationMs: 1,
    resultSubtype: "error_during_execution",
    isError: true,
    usage: { inputTokens: 0, outputTokens: 0 },
  });
  const script = `${META}\nreturn await parallel([() => agent('bad', { executor: 'fake' })]);\n`;
  const result = await runWorkflow({ script, executors: { fake: failing }, runDir: uniqueRunDir("s"), maxRetries: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.failedAgents, 1);
  // run_end carries ok:true (the script completed) plus the advisory failedAgents count.
  // run_end 带有 ok:true（脚本已完成）以及通告性的 failedAgents 计数。
  assert.equal(result.events.some((event) => event.type === "run_end" && event.ok), true);
  const runEnd = result.events.find((event) => event.type === "run_end");
  assert.equal(runEnd?.type === "run_end" ? runEnd.failedAgents : undefined, 1);
});

test("(r) a failing agent surfaces the executor's reason in the error + agent_end event", async () => {
  const failing: Executor = async () => ({
    text: "You've hit your usage limit. Try again later.",
    sessionId: null,
    costUsd: 0,
    durationMs: 1,
    resultSubtype: "error_during_execution",
    isError: true,
    usage: { inputTokens: 0, outputTokens: 0 },
  });

  const events: ProgressEvent[] = [];
  const script = `${META}\nreturn await agent('do thing', { executor: 'boom' });\n`;
  await assert.rejects(
    runWorkflow({
      script,
      executors: { boom: failing },
      runDir: uniqueRunDir("r"),
      onEvent: (e) => events.push(e),
      maxRetries: 0,
    }),
    /usage limit/i,
  );

  // the agent_end event carries the same reason, so the progress tree renders it.
  // agent_end 事件带上同一个原因，从而进度树会渲染它。
  assert.ok(
    events.some(
      (e) => e.type === "agent_end" && e.ok === false && /usage limit/i.test(e.error ?? ""),
    ),
    "agent_end.error should include the executor's reason",
  );
});

// ────────────────────────────────────────────────────────────────────────────
// (t) Retry: a transient error_during_execution is retried, then succeeds. The agent resolves to
// the successful value; tokens are counted ONCE (for the successful attempt, not the sum of all
// attempts). Uses retryBackoffMs:1 so the suite stays fast.
// (t) 重试：瞬时 error_during_execution 被重试后成功。agent 解析为成功值；token 只计一次
//（成功那次，而非所有尝试之和）。用 retryBackoffMs:1 保持测试快速。
// ────────────────────────────────────────────────────────────────────────────

test("(t) Bug A+B+C: transient failure retried to success; tokens counted once", async () => {
  let calls = 0;
  const flaky: Executor = async (opts) => {
    calls++;
    if (calls < 3) {
      // First two attempts: transient CLI crash ("Turn execution failed"). Retried.
      // 前两次：瞬时 CLI 崩溃（"Turn execution failed"）。会被重试。
      return {
        text: "Turn execution failed (traceId: abc)",
        sessionId: null,
        costUsd: 0,
        durationMs: 1,
        resultSubtype: "error_during_execution",
        isError: true,
        usage: { inputTokens: 100, outputTokens: 50 },
      };
    }
    // Third attempt: success, with its own token count.
    // 第三次：成功，带自己的 token 计数。
    return makeFakeResult(opts);
  };
  const script = `${META}\nreturn await agent('flaky node', { executor: 'flaky' });\n`;
  const res = await runWorkflow({
    script,
    executors: { flaky },
    runDir: uniqueRunDir("t"),
    maxRetries: 3,
    retryBackoffMs: 1,
  });

  assert.equal(calls, 3, "two retries then success → 3 executor calls");
  assert.equal(res.ok, true);
  assert.equal(res.failedAgents, 0);
  // The agent resolved to the successful value.
  // agent 解析为成功的值。
  assert.equal(res.value, "FAKE:flaky node");
  // Bug C: tokens counted ONCE for the successful attempt (outputTokens=5 from makeFakeResult),
  // NOT the sum of the two failed attempts (which would be 50+50+5=110).
  // Bug C：token 只对成功那次计一次（makeFakeResult 的 outputTokens=5），而非两次失败尝试
  // 之和（否则为 50+50+5=110）。
  assert.equal(res.tokensSpent, 5);
});

// ────────────────────────────────────────────────────────────────────────────
// (u) Retry: a PERMANENT failure (error_max_turns) is NOT retried — fails on the first attempt.
// (u) 重试：永久失败（error_max_turns）不重试——第一次尝试即失败。
// ────────────────────────────────────────────────────────────────────────────

test("(u) Bug B: permanent failure (error_max_turns) is not retried", async () => {
  let calls = 0;
  const permanent: Executor = async () => {
    calls++;
    return {
      text: "max turns",
      sessionId: null,
      costUsd: 0,
      durationMs: 1,
      resultSubtype: "error_max_turns",
      isError: true,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  };
  const script = `${META}\nreturn await agent('exhausted', { executor: 'perm' });\n`;
  await assert.rejects(
    runWorkflow({
      script,
      executors: { perm: permanent },
      runDir: uniqueRunDir("u"),
      maxRetries: 5,
      retryBackoffMs: 1,
    }),
  );
  assert.equal(calls, 1, "error_max_turns is permanent → exactly 1 call, no retries");
});

// ────────────────────────────────────────────────────────────────────────────
// (v) Retry: exhausting the budget on a persistent transient failure still fails (and reports the
// last attempt). maxRetries:2 → 3 total calls, then permanent failure.
// (v) 重试：持续瞬时失败耗尽预算后仍失败（并报告最后一次尝试）。maxRetries:2 → 共 3 次调用，然后失败。
// ────────────────────────────────────────────────────────────────────────────

test("(v) Bug A: persistent transient failure exhausts retries and fails", async () => {
  let calls = 0;
  const alwaysTransient: Executor = async () => {
    calls++;
    return {
      text: "Turn execution failed (traceId: xyz)",
      sessionId: null,
      costUsd: 0,
      durationMs: 1,
      resultSubtype: "error_during_execution",
      isError: true,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  };
  const script = `${META}\nreturn await agent('always down', { executor: 'down' });\n`;
  await assert.rejects(
    runWorkflow({
      script,
      executors: { down: alwaysTransient },
      runDir: uniqueRunDir("v"),
      maxRetries: 2,
      retryBackoffMs: 1,
    }),
  );
  // 1 initial + 2 retries = 3 total calls before giving up.
  // 1 次初始 + 2 次重试 = 共 3 次调用后放弃。
  assert.equal(calls, 3, "maxRetries:2 → 3 total attempts then permanent failure");
});

// ────────────────────────────────────────────────────────────────────────────
// (w) Retry: per-agent `retries: 0` overrides a run-wide maxRetries, disabling retry for that node.
// (w) 重试：按 agent 的 `retries: 0` 覆盖运行级 maxRetries，对该节点关闭重试。
// ────────────────────────────────────────────────────────────────────────────

test("(w) Bug A: per-agent retries:0 overrides run-wide maxRetries", async () => {
  let calls = 0;
  const transient: Executor = async () => {
    calls++;
    return {
      text: "Turn execution failed",
      sessionId: null,
      costUsd: 0,
      durationMs: 1,
      resultSubtype: "error_during_execution",
      isError: true,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  };
  const script = `${META}\nreturn await agent('no retry here', { executor: 't', retries: 0 });\n`;
  await assert.rejects(
    runWorkflow({
      script,
      executors: { t: transient },
      runDir: uniqueRunDir("w"),
      maxRetries: 5,
      retryBackoffMs: 1,
    }),
  );
  assert.equal(calls, 1, "per-agent retries:0 → no retries despite run-wide maxRetries:5");
});
