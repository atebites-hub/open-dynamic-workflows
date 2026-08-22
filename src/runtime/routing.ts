import { createHash } from "node:crypto";

import type { AgentOptions, Executor, RoutingPolicy } from "../types.js";

const FIELDS = ["executor", "model", "reasoningEffort"] as const;
type RoutingField = (typeof FIELDS)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeRoutingPolicy(
  policy: unknown,
  executors: Record<string, Executor>,
): Readonly<RoutingPolicy> {
  if (!isRecord(policy)) throw new Error("routingPolicy must be an object");
  for (const key of Object.keys(policy)) {
    if (!(FIELDS as readonly string[]).includes(key)) throw new Error(`routingPolicy unknown field "${key}"`);
  }
  const values = {} as Record<RoutingField, string>;
  for (const field of FIELDS) {
    const value = policy[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`routingPolicy ${field} must be a non-empty string`);
    }
    values[field] = value.trim();
  }
  if (executors[values.executor] === undefined) {
    throw new Error(`routingPolicy references unregistered executor "${values.executor}"`);
  }
  return Object.freeze({
    executor: values.executor,
    model: values.model,
    reasoningEffort: values.reasoningEffort,
  });
}

export function fingerprintRoutingPolicy(policy: Readonly<RoutingPolicy>): string {
  return createHash("sha256").update(JSON.stringify({
    executor: policy.executor,
    model: policy.model,
    reasoningEffort: policy.reasoningEffort,
  })).digest("hex");
}

export function resolveAgentRoute(
  policy: Readonly<RoutingPolicy> | undefined,
  options: Partial<Pick<AgentOptions, RoutingField>>,
): Readonly<RoutingPolicy> | Partial<Pick<AgentOptions, RoutingField>> {
  if (!policy) return options;
  for (const field of FIELDS) {
    if (options[field] !== undefined && options[field] !== policy[field]) {
      throw new Error(`routing policy ${field} conflict: requested "${options[field]}" but policy requires "${policy[field]}"`);
    }
  }
  return policy;
}
