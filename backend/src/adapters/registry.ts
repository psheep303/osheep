import { AdapterError } from "./errors.js";
import type { AgentAdapter } from "./types.js";
export class AdapterRegistryImpl {
  private readonly adapters = new Map<string, AgentAdapter>();
  register(adapter: AgentAdapter): void {
    if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/i.test(adapter.id)) {
      throw new AdapterError("INVALID_CONFIG", `Invalid adapter id: ${adapter.id}`, {
        adapterId: adapter.id,
      });
    }
    if (!adapter.version || !adapter.name.trim()) {
      throw new AdapterError("INVALID_CONFIG", `Adapter metadata is incomplete: ${adapter.id}`, {
        adapterId: adapter.id,
      });
    }
    if (this.adapters.has(adapter.id))
      throw new AdapterError("UNKNOWN", `Adapter already registered: ${adapter.id}`, {
        adapterId: adapter.id,
      });
    this.adapters.set(adapter.id, adapter);
  }
  get(id: string): AgentAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter)
      throw new AdapterError("UNSUPPORTED", `Unknown adapter: ${id}`, { adapterId: id });
    return adapter;
  }
  has(id: string): boolean {
    return this.adapters.has(id);
  }
  list(): AgentAdapter[] {
    return [...this.adapters.values()];
  }
}
export type AdapterRegistry = AdapterRegistryImpl;
