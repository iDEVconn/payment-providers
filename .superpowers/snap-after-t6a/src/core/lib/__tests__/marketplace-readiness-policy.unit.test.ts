import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MARKETPLACE_SELLER_READINESS_MAX_AGE_MS,
  parseMarketplaceSellerReadinessMaxAgeMs,
  resolveMarketplaceSellerReadinessMaxAgeMs,
} from '../marketplace-readiness-policy';

describe('marketplace readiness policy', () => {
  it('defaults to fifteen minutes when marketplace is disabled', () => {
    expect(
      resolveMarketplaceSellerReadinessMaxAgeMs({
        marketplaceEnabled: false,
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
        marketplaceEnabled: true,
        nodeEnv: 'production',
      }),
    ).toThrow(/max age must be configured explicitly/);
  });

  it('uses configured max age when marketplace is enabled in production', () => {
    expect(
      resolveMarketplaceSellerReadinessMaxAgeMs({
        marketplaceEnabled: true,
        sellerReadinessMaxAgeMs: 120_000,
        nodeEnv: 'production',
      }),
    ).toBe(120_000);
  });
});
