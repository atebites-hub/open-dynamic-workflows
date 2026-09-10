import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { runWorkflow } from "./run.js";
import type { ExecOptions, ExecResult } from "../types.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (cwd: string, message: string) => git(cwd, "-c", "user.name=ODW Test", "-c", "user.email=odw-test@example.invalid", "commit", "-qm", message);
const result = (): ExecResult => ({ text: "ok", sessionId: null, costUsd: 0, durationMs: 1, resultSubtype: "success", isError: false, usage: { inputTokens: 0, outputTokens: 0 } });
const script = (body: string) => `export const meta={name:'worktree-test',description:'isolation contract'}; ${body}`;
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "odw-worktree-test-"));
  const repo = join(directory, "repo");
  mkdirSync(join(repo, "package"), { recursive: true });
  writeFileSync(join(repo, "package", "tracked.txt"), "base\n");
  writeFileSync(join(repo, ".gitignore"), "ignored.txt\n.odw/\n");
  git(repo, "init", "-q"); git(repo, "add", "."); commit(repo, "base");
  return { repo, runDir: join(directory, "runs") };
}

for (const kind of ["clean", "dirty", "untracked", "ignored", "commit", "failure", "abort"] as const) {
  test(`worktree lifecycle preserves ${kind} evidence without force removal`, async () => {
    const { repo, runDir } = fixture();
    let worker = "";
    const controller = new AbortController();
    const run = runWorkflow({ cwd: repo, runDir, signal: controller.signal,
      script: script("return await agent('fixture',{executor:'fake',isolation:'worktree'});"),
      executors: { fake: async (opts) => {
        worker = opts.cwd;
        if (kind === "dirty") writeFileSync(join(worker, "package", "tracked.txt"), "changed\n");
        if (kind === "untracked" || kind === "commit") writeFileSync(join(worker, "result.txt"), "result\n");
        if (kind === "ignored") writeFileSync(join(worker, "ignored.txt"), "retain\n");
        if (kind === "commit") { git(worker, "add", "result.txt"); commit(worker, "worker result"); }
        if (kind === "failure") throw new Error("fixture failure");
        if (kind === "abort") { controller.abort(); throw new Error("fixture aborted"); }
        return result();
      } },
    });
    if (kind === "failure" || kind === "abort") await assert.rejects(run);
    else {
      const completed = await run;
      assert.equal(completed.ok, true);
      assert.ok(completed.events.some((event) => event.type === "log" && event.message.includes(kind === "clean" ? "removed pristine" : "retained")));
    }
    assert.equal(existsSync(worker), kind !== "clean");
    assert.equal(readFileSync(join(repo, "package", "tracked.txt"), "utf8"), "base\n");
    assert.equal(git(repo, "status", "--porcelain"), "");
    if (kind === "commit") assert.equal(readFileSync(join(worker, "result.txt"), "utf8"), "result\n");
  });
}

test("workers preserve caller subdirectory and isolate parallel writes", async () => {
  const { repo, runDir } = fixture();
  const workers: string[] = [];
  await runWorkflow({ cwd: join(repo, "package"), runDir,
    script: script("return await parallel([()=>agent('one',{executor:'fake',isolation:'worktree'}),()=>agent('two',{executor:'fake',isolation:'worktree'})]);"),
    executors: { fake: async (opts) => {
      workers.push(opts.cwd);
      assert.equal(readFileSync(join(opts.cwd, "tracked.txt"), "utf8"), "base\n");
      writeFileSync(join(opts.cwd, "result.txt"), opts.prompt);
      return result();
    } },
  });
  assert.equal(new Set(workers).size, 2);
  assert.ok(workers.every((worker) => dirname(worker).includes("worktrees")));
  assert.equal(existsSync(join(repo, "package", "result.txt")), false);
});

test("queued and nested workers share one committed base, leaving caller edits alone", async () => {
  const { repo, runDir } = fixture();
  const base = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "unstaged.txt"), "user work\n");
  const nested = join(runDir, "nested.js"); mkdirSync(runDir);
  writeFileSync(nested, script("return await agent('nested',{executor:'fake',isolation:'worktree'});"));
  const heads: string[] = [];
  await runWorkflow({ cwd: repo, runDir, concurrency: 1,
    script: script("await agent('first',{executor:'fake',isolation:'worktree'}); return await workflow({scriptPath:args.nested});"), args: { nested },
    executors: { fake: async (opts: ExecOptions) => {
      heads.push(git(opts.cwd, "rev-parse", "HEAD"));
      if (opts.prompt === "first") { writeFileSync(join(repo, "later.txt"), "later\n"); git(repo, "add", "later.txt"); commit(repo, "caller advanced"); }
      return result();
    } },
  });
  assert.deepEqual(heads, [base, base]);
  assert.equal(readFileSync(join(repo, "unstaged.txt"), "utf8"), "user work\n");
});

test("isolation failure never invokes the executor in the caller directory", async () => {
  const directory = mkdtempSync(join(tmpdir(), "odw-not-a-repo-"));
  let calls = 0;
  await assert.rejects(runWorkflow({ cwd: directory, runDir: join(directory, "runs"),
    script: script("return await agent('fixture',{executor:'fake',isolation:'worktree'});"),
    executors: { fake: async () => { calls++; return result(); } },
  }));
  assert.equal(calls, 0);
});

test("run-wide isolation preserves named branches and journal patches for two writers", async () => {
  const { repo, runDir } = fixture();
  const workers: string[] = [];
  const branches: string[] = [];
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const completed = await runWorkflow({ cwd: repo, runDir, isolation: "worktree", concurrency: 2,
    script: script("return await parallel([()=>agent('one',{executor:'fake'}),()=>agent('two',{executor:'fake'})]);"),
    executors: { fake: async (opts) => {
      workers.push(opts.cwd);
      branches.push(git(opts.cwd, "branch", "--show-current"));
      if (workers.length === 2) release();
      await barrier;
      writeFileSync(join(opts.cwd, "package/tracked.txt"), opts.prompt + "\n");
      if (opts.prompt === "one") { git(opts.cwd, "add", "package/tracked.txt"); commit(opts.cwd, "retain committed result"); }
      return result();
    } },
  });
  assert.equal(completed.ok, true);
  assert.equal(new Set(workers).size, 2);
  assert.equal(new Set(branches).size, 2);
  assert.ok(branches.every((branch) => branch.startsWith(`odw/${completed.runId}/agent-`)));
  assert.ok(workers.every((worker) => existsSync(worker)));
  assert.equal(readFileSync(join(repo, "package/tracked.txt"), "utf8"), "base\n");
  for (let id = 1; id <= 2; id++) {
    const receipt = JSON.parse(readFileSync(join(runDir, completed.runId, "agents", `agent-${id}.worktree.json`), "utf8"));
    assert.match(receipt.branch, /^odw\//);
    assert.match(readFileSync(receipt.diff, "utf8"), /tracked\.txt/);
  }
});

test("a swallowed worktree receipt failure remains a counted failure", async () => {
  const { repo, runDir } = fixture();
  let worker = "";
  const completed = await runWorkflow({ cwd: repo, runDir, isolation: "worktree",
    script: script("return await parallel([()=>agent('receipt failure',{executor:'fake'})]);"),
    executors: { fake: async (opts) => {
      worker = opts.cwd;
      assert.ok(opts.tracePath);
      mkdirSync(opts.tracePath.replace(/\.jsonl$/, ".diff"), { recursive: true });
      return result();
    } },
  });
  assert.equal(completed.failedAgents, 1);
  assert.deepEqual(completed.value, [null]);
  assert.equal(existsSync(worker), true);
});
