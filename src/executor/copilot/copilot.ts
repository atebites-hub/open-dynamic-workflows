import type { ExecOptions, Executor } from "../../types.js";
import { type ExecResultCore, makeSubprocessExecutor } from "../subprocess.js";

type ObjectValue = Record<string, any>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const tokens = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

export function buildCopilotArgs(opts: ExecOptions): string[] {
  if (opts.reasoningEffort && !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(opts.reasoningEffort)) {
    throw new Error(`Copilot does not support effort ${opts.reasoningEffort}`);
  }
  const prompt = [opts.appendSystemPrompt, opts.schema ? `Return only JSON matching this schema: ${JSON.stringify(opts.schema)}` : undefined, opts.prompt].filter(Boolean).join("\n\n");
  const args = ["-C", opts.cwd, "-p", prompt, "--output-format", "json", "--stream", "off",
    "--no-auto-update", "--no-ask-user", "--no-remote-export", "--disable-builtin-mcps",
    "--disable-mcp-server", "open-dynamic-workflows", "--allow-tool", "write", "--allow-tool", "shell"];
  if (opts.model) args.push("--model", opts.model);
  if (opts.reasoningEffort) args.push("--effort", opts.reasoningEffort);
  if (opts.resumeSessionId) args.push(`--resume=${opts.resumeSessionId}`);
  return args;
}

export function reduceCopilotEvents(events: unknown[], exitCode: number | null, schema = false, stderr = ""): ExecResultCore {
  const records = events.map(object);
  const result = [...records].reverse().find((event) => event.type === "result");
  const error = [...records].reverse().find((event) => event.type === "session.error");
  const detail = object(error?.data);
  const ok = exitCode === 0 && result?.exitCode === 0 && error === undefined;
  const text = records.filter((event) => event.type === "assistant.message" && !event.agentId)
    .map((event) => object(event.data).content).filter((value) => typeof value === "string").join("\n");
  const usage = records.filter((event) => event.type === "assistant.usage").map((event) => object(event.data));
  let structuredOutput: unknown;
  if (schema && ok) { try { structuredOutput = JSON.parse(text); } catch { /* runtime schema validation rejects this */ } }
  return {
    text: ok ? text : typeof detail.message === "string" ? detail.message : stderr.trim() || "Copilot did not emit a successful terminal result",
    sessionId: typeof result?.sessionId === "string" ? result.sessionId : null,
    costUsd: 0,
    resultSubtype: ok ? "success" : typeof detail.errorCode === "string" ? detail.errorCode : "copilot_error",
    isError: !ok,
    usage: { inputTokens: usage.reduce((sum, value) => sum + tokens(value.inputTokens), 0), outputTokens: usage.reduce((sum, value) => sum + tokens(value.outputTokens), 0) },
    telemetryAvailable: usage.some((value) => typeof value.inputTokens === "number" && typeof value.outputTokens === "number"),
    ...(structuredOutput !== undefined ? { structuredOutput } : {}),
  };
}

export const copilotExecutor: Executor = (opts) => makeSubprocessExecutor({
  command: process.env.COPILOT_BIN?.trim() || "copilot",
  prepare: async (options) => ({ args: buildCopilotArgs(options) }),
  parseLine: (line) => { try { return JSON.parse(line); } catch { return null; } },
  reduce: (events, context) => reduceCopilotEvents(events, context.exitCode, context.opts.schema !== undefined, context.stderr),
})(opts);
