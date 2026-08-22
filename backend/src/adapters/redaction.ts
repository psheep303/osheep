import type { AdapterConfigSchema } from "./types.js";

export function redactAdapterConfig(
  config: Record<string, unknown> | undefined,
  schema?: AdapterConfigSchema,
): Record<string, unknown> {
  if (!config) return {};
  const secretKeys = new Set(
    (schema?.fields ?? []).filter((field) => field.secret).map((field) => field.key),
  );
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => [
      key,
      secretKeys.has(key) ? "[REDACTED]" : redactValue(value),
    ]),
  );
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      const sensitive = /token|secret|password|api[-_]?key|authorization/i.test(key);
      return [key, sensitive ? "[REDACTED]" : redactValue(item)];
    }),
  );
}
