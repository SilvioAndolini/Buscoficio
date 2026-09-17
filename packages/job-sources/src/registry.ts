import type { JobSourceAdapter } from '@job-system/core';

/** Adapter registry: discovery sources are resolved by key, never hardcoded. */
export class SourceRegistry {
  private readonly adapters = new Map<string, JobSourceAdapter>();

  register(adapter: JobSourceAdapter): void {
    this.adapters.set(adapter.key, adapter);
  }

  get(key: string): JobSourceAdapter | undefined {
    return this.adapters.get(key);
  }

  require(key: string): JobSourceAdapter {
    const adapter = this.adapters.get(key);
    if (!adapter) throw new Error(`Unknown source adapter: ${key}`);
    return adapter;
  }

  list(): JobSourceAdapter[] {
    return [...this.adapters.values()];
  }
}