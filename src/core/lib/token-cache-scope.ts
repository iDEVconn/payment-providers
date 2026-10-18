import type { PaymentEnvironment } from '../../contracts/index';

export type TokenCacheScopeInput = {
  accountRef: string;
  environment: PaymentEnvironment;
};

/** Stable cache identity for OAuth tokens — never share across accounts or environments. */
export function tokenCacheScope(input: TokenCacheScopeInput): string {
  return `${input.accountRef}::${input.environment}`;
}
