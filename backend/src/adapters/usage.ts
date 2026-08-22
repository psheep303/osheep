import type { AdapterUsageProvider, AgentUsage, UsageInput } from "./types.js";

export class EmptyUsageProvider implements AdapterUsageProvider {
  async readSessionUsage(_input: UsageInput): Promise<AgentUsage> {
    return {};
  }
}

export function normalizeAgentUsage(value: unknown): AgentUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const number = (key: string): number | undefined =>
    typeof raw[key] === "number" && Number.isFinite(raw[key]) && raw[key] >= 0
      ? (raw[key] as number)
      : undefined;
  const usage: AgentUsage = {
    inputTokens: number("inputTokens") ?? number("input_tokens"),
    outputTokens: number("outputTokens") ?? number("output_tokens"),
    cacheReadTokens: number("cacheReadTokens") ?? number("cache_read_tokens"),
    cacheWriteTokens: number("cacheWriteTokens") ?? number("cache_write_tokens"),
    totalTokens: number("totalTokens") ?? number("total_tokens"),
    cost: number("cost"),
    model: typeof raw.model === "string" ? raw.model : undefined,
  };
  if (
    usage.totalTokens === undefined &&
    usage.inputTokens !== undefined &&
    usage.outputTokens !== undefined
  ) {
    usage.totalTokens = usage.inputTokens + usage.outputTokens;
  }
  return usage;
}
