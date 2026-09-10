import type { ExecOptions, Executor } from "../../types.js";
import { type ExecResultCore, makeSubprocessExecutor } from "../subprocess.js";

type ObjectValue = Record<string, any>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const tokens = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

export function buildAntigravityArgs(opts: ExecOptions): string[] {
  if (opts.reasoningEffort && !["low", "medium", "high"].includes(opts.reasoningEffort)) {
    throw new Error(`Antigravity does not support effort ${opts.reasoningEffort}`);
  }
  const prompt = [opts.appendSystemPrompt, opts.prompt].filter(Boolean).join("\n\n");
  const args = ["--print", prompt, "--output-format", "stream-json", "--mode", "accept-edits"];
  // An existing/default project can point at the parent checkout, not opts.cwd.
  if (opts.resumeSessionId) args.push("--conversation", opts.resumeSessionId);
  else args.push("--new-project");
  if (opts.model) args.push("--model", opts.model);
  if (opts.reasoningEffort) args.push("--effort", opts.reasoningEffort);
  if (opts.schema) args.push("--json-schema", JSON.stringify(opts.schema));
  if (opts.timeoutMs !== undefined) args.push("--print-timeout", `${Math.max(1, Math.ceil(opts.timeoutMs / 1000))}s`);
  return args;
}

export function reduceAntigravityEvents(events: unknown[], exitCode: number | null, stderr = ""): ExecResultCore {
  const records = events.map(object);
  const envelope = [...records].reverse().find((event) => event.event === "result" || typeof event.status === "string");
  const result = object(envelope?.event === "result" ? envelope.result : envelope);
  const denied = Array.isArray(result.denied_actions) && result.denied_actions.length > 0;
  const ok = exitCode === 0 && result.status === "SUCCESS" && !denied;
  const usage = object(result.usage);
  const error = denied ? `Antigravity permission denied: ${JSON.stringify(result.denied_actions)}`
    : typeof result.error === "string" ? result.error : stderr.trim() || `Antigravity terminal status: ${result.status ?? "missing"}`;
  return {
    text: ok && typeof result.response === "string" ? result.response : error,
    sessionId: typeof result.conversation_id === "string" ? result.conversation_id : null,
    costUsd: 0,
    resultSubtype: ok ? "success" : denied ? "permission_denied" : "antigravity_error",
    isError: !ok,
    usage: { inputTokens: tokens(usage.input_tokens), outputTokens: tokens(usage.output_tokens) },
    telemetryAvailable: typeof usage.input_tokens === "number" && typeof usage.output_tokens === "number",
    ...(result.structured_output !== undefined ? { structuredOutput: result.structured_output } : {}),
  };
}

export const antigravityExecutor: Executor = (opts) => makeSubprocessExecutor({
  command: process.env.ANTIGRAVITY_BIN?.trim() || process.env.AGY_BIN?.trim() || "agy",
  prepare: async (options) => ({ args: buildAntigravityArgs(options) }),
  parseLine: (line) => { try { return JSON.parse(line); } catch { return null; } },
  reduce: (events, context) => reduceAntigravityEvents(events, context.exitCode, context.stderr),
})(opts);
