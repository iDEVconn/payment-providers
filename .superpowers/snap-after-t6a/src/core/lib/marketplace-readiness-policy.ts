/** Documented safe default: 15 minutes. */
export const DEFAULT_MARKETPLACE_SELLER_READINESS_MAX_AGE_MS = 15 * 60 * 1000;

export type ResolveMarketplaceSellerReadinessMaxAgeInput = {
  marketplaceEnabled: boolean;
  sellerReadinessMaxAgeMs?: number;
  nodeEnv?: string;
};

export function parseMarketplaceSellerReadinessMaxAgeMs(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === '') {
    return null;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

export function resolveMarketplaceSellerReadinessMaxAgeMs(
  input: ResolveMarketplaceSellerReadinessMaxAgeInput,
): number {
  if (input.sellerReadinessMaxAgeMs != null) {
    const parsed = parseMarketplaceSellerReadinessMaxAgeMs(String(input.sellerReadinessMaxAgeMs));
    if (parsed != null) {
      return parsed;
    }
  }

  if (input.marketplaceEnabled && input.nodeEnv === 'production') {
    throw new Error(
      'Marketplace seller readiness max age must be configured explicitly when marketplace is enabled in production',
    );
  }

  return DEFAULT_MARKETPLACE_SELLER_READINESS_MAX_AGE_MS;
}
