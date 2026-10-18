import { formatEnvBanner } from './host-env-banner';
import { readEnvEnabled, type EnvGetter } from './env-access';

export const MARKETPLACE_SELLER_READINESS_MAX_AGE_ENV_KEY =
  'PAYMENT_MARKETPLACE_SELLER_READINESS_MAX_AGE_MS';

/** Documented safe default: 15 minutes. */
export const DEFAULT_MARKETPLACE_SELLER_READINESS_MAX_AGE_MS = 15 * 60 * 1000;

export type ResolveMarketplaceSellerReadinessMaxAgeInput = {
  get: EnvGetter;
  nodeEnv?: string;
  envPath?: string;
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
  const marketplaceEnabled = readEnvEnabled(input.get, 'PAYPAL_MARKETPLACE_ENABLED', false);
  const parsed = parseMarketplaceSellerReadinessMaxAgeMs(
    input.get(MARKETPLACE_SELLER_READINESS_MAX_AGE_ENV_KEY),
  );

  if (parsed != null) {
    return parsed;
  }

  if (marketplaceEnabled && input.nodeEnv === 'production') {
    throw new Error(
      formatEnvBanner({
        service: 'payment',
        provider: 'marketplace',
        missing: [MARKETPLACE_SELLER_READINESS_MAX_AGE_ENV_KEY],
        envPath: input.envPath ?? 'apps/microservices/payment/.env',
        headline:
          '⚠  payment — marketplace seller readiness max age missing or invalid (startup aborted)',
      }),
    );
  }

  return DEFAULT_MARKETPLACE_SELLER_READINESS_MAX_AGE_MS;
}
