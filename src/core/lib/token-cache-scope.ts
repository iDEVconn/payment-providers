import type { PaymentEnvironment } from '../../contracts/index';

export type TokenCacheScopeInput = {
  accountRef: string;
  environment: PaymentEnvironment;
  /** OAuth client id; rotated credentials must never reuse a token cached for another client. */
  clientId?: string;
};

/** Stable cache identity for OAuth tokens — never share across accounts, environments or client ids. */
export function tokenCacheScope(input: TokenCacheScopeInput): string {
  const base = `${input.accountRef}::${input.environment}`;
  return input.clientId ? `${base}::${input.clientId}` : base;
}
