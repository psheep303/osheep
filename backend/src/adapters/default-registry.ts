import { ClaudeCodeAdapter } from "./claude-code-adapter.js";
import { CodexAdapter } from "./codex-adapter.js";
import { AdapterRegistryImpl } from "./registry.js";
export function createDefaultAdapterRegistry(): AdapterRegistryImpl {
  const registry = new AdapterRegistryImpl();
  registry.register(new ClaudeCodeAdapter());
  registry.register(new CodexAdapter());
  return registry;
}
export const adapterRegistry = createDefaultAdapterRegistry();
