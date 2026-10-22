import { describe, expect, it } from 'vitest';
import { ScopedTokenCacheRegistry } from '../scoped-token-cache-registry';
import { tokenCacheScope } from '../token-cache-scope';

describe('token cache scope isolation', () => {
  it('uses distinct keys for different account references', () => {
    expect(tokenCacheScope({ accountRef: 'acct-a', environment: 'sandbox' })).not.toBe(
      tokenCacheScope({ accountRef: 'acct-b', environment: 'sandbox' }),
    );
  });

  it('uses distinct keys for sandbox and live environments', () => {
    expect(tokenCacheScope({ accountRef: 'default', environment: 'sandbox' })).not.toBe(
      tokenCacheScope({ accountRef: 'default', environment: 'live' }),
    );
  });

  it('does not share registry entries across account references', () => {
    const registry = new ScopedTokenCacheRegistry<object>();
    const first = registry.get({ accountRef: 'acct-a', environment: 'sandbox' }, () => ({}));
    const second = registry.get({ accountRef: 'acct-b', environment: 'sandbox' }, () => ({}));
    expect(first).not.toBe(second);
    expect(registry.size()).toBe(2);
  });
});

describe('token cache scope client id', () => {
  it('uses distinct keys for different OAuth client ids and keeps the legacy key without one', () => {
    const scope = { accountRef: 'default', environment: 'sandbox' as const };
    expect(tokenCacheScope({ ...scope, clientId: 'client-a' })).not.toBe(
      tokenCacheScope({ ...scope, clientId: 'client-b' }),
    );
    expect(tokenCacheScope({ ...scope, clientId: 'client-a' })).not.toBe(tokenCacheScope(scope));
    expect(tokenCacheScope(scope)).toBe('default::sandbox');
  });
});
