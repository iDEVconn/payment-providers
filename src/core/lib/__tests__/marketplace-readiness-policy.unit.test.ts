import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MARKETPLACE_SELLER_READINESS_MAX_AGE_MS,
  MARKETPLACE_SELLER_READINESS_MAX_AGE_ENV_KEY,
  parseMarketplaceSellerReadinessMaxAgeMs,
  resolveMarketplaceSellerReadinessMaxAgeMs,
} from '../marketplace-readiness-policy';

describe('marketplace readiness policy', () => {
  it('defaults to fifteen minutes when marketplace is disabled', () => {
    expect(
      resolveMarketplaceSellerReadinessMaxAgeMs({
        get: () => undefined,
        nodeEnv: 'development',
      }),
    ).toBe(DEFAULT_MARKETPLACE_SELLER_READINESS_MAX_AGE_MS);
  });

  it('parses configured max age in milliseconds', () => {
    expect(parseMarketplaceSellerReadinessMaxAgeMs('600000')).toBe(600_000);
    expect(parseMarketplaceSellerReadinessMaxAgeMs('0')).toBeNull();
    expect(parseMarketplaceSellerReadinessMaxAgeMs('abc')).toBeNull();
  });

  it('fails closed in production when marketplace is enabled without max age', () => {
    expect(() =>
      resolveMarketplaceSellerReadinessMaxAgeMs({
        get: (key) => (key === 'PAYPAL_MARKETPLACE_ENABLED' ? 'true' : undefined),
        nodeEnv: 'production',
      }),
    ).toThrow(MARKETPLACE_SELLER_READINESS_MAX_AGE_ENV_KEY);
  });

  it('uses configured max age when marketplace is enabled in production', () => {
    expect(
      resolveMarketplaceSellerReadinessMaxAgeMs({
        get: (key) => {
          if (key === 'PAYPAL_MARKETPLACE_ENABLED') return 'true';
          if (key === MARKETPLACE_SELLER_READINESS_MAX_AGE_ENV_KEY) return '120000';
          return undefined;
        },
        nodeEnv: 'production',
      }),
    ).toBe(120_000);
  });
});
