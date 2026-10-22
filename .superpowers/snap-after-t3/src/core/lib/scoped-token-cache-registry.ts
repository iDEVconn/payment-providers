import { tokenCacheScope, type TokenCacheScopeInput } from './token-cache-scope';

/** In-memory registry proving account/environment isolation for provider instances. */
export class ScopedTokenCacheRegistry<T> {
  private readonly entries = new Map<string, T>();

  get(scope: TokenCacheScopeInput, factory: () => T): T {
    const key = tokenCacheScope(scope);
    const existing = this.entries.get(key);
    if (existing) {
      return existing;
    }
    const created = factory();
    this.entries.set(key, created);
    return created;
  }

  has(scope: TokenCacheScopeInput): boolean {
    return this.entries.has(tokenCacheScope(scope));
  }

  size(): number {
    return this.entries.size;
  }
}
