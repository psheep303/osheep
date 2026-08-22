import assert from "node:assert/strict";
import type { AdapterCapabilities, AgentAdapter } from "./types.js";

export interface AdapterContractTestOptions {
  create: () => AgentAdapter;
  capabilities?: Partial<AdapterCapabilities>;
}

/** Lightweight assertions shared by built-in and third-party adapter test suites. */
export function createAdapterContractTests(options: AdapterContractTestOptions): () => void {
  return () => {
    const adapter = options.create();
    assert.match(adapter.id, /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/i);
    assert.ok(adapter.name.trim());
    assert.ok(adapter.version.trim());
    const capabilities = adapter.getCapabilities();
    for (const [key, expected] of Object.entries(options.capabilities ?? {})) {
      assert.deepEqual(
        (capabilities as unknown as Record<string, unknown>)[key],
        expected,
        `capability ${key}`,
      );
    }
    const schema = adapter.getConfigSchema();
    assert.ok(Array.isArray(schema.fields));
    for (const field of schema.fields) {
      assert.ok(field.key.trim());
      assert.ok(field.label.trim());
      if (field.type === "select") assert.ok(Array.isArray(field.options));
    }
  };
}
