import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { openJournal } from "./journal.js";

test("journal close reports append failures as non-durable", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "odw-journal-"));
  const runId = "run-failure";
  const runDir = path.join(baseDir, runId);
  await mkdir(path.join(runDir, "journal.jsonl"), { recursive: true });
  await mkdir(path.join(runDir, "events.jsonl"), { recursive: true });

  const journal = await openJournal({ baseDir, runId });
  journal.append({
    index: 1,
    key: "key",
    label: "label",
    phase: null,
    result: "result",
    cached: false,
    outputTokens: 1,
    ts: new Date().toISOString(),
  });
  journal.appendEvent({ type: "event" });

  const result = await journal.close();

  assert.equal(result.durable, false);
  assert.equal(result.errors.length, 2);
  assert.ok(result.errors.some((error) => error.includes("append failed")));
  assert.ok(result.errors.some((error) => error.includes("event append failed")));
});
