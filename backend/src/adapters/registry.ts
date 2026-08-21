import { AdapterError } from "./errors.js";
import type { AgentAdapter } from "./types.js";
export class AdapterRegistryImpl {
  private readonly adapters = new Map<string, AgentAdapter>();
  register(adapter: AgentAdapter): void {
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
