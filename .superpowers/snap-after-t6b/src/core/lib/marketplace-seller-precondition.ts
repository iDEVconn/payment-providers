import {
  PAYMENT_RELIABILITY_ERROR,
  PaymentReliabilityError,
  type SellerConnectionRecord,
} from '../../contracts/index';
import { reconcileSellerConnectionAggregate } from './seller-connection-reconciliation';
import type { SellerConnectionReconciliationLookup } from './seller-connection-reconciliation';
import { DEFAULT_MARKETPLACE_SELLER_READINESS_MAX_AGE_MS } from './marketplace-readiness-policy';
import type { PaymentReliabilityStore } from './persistence/payment-reliability-store';

export const MARKETPLACE_SELLER_READINESS_MAX_AGE_MS =
  DEFAULT_MARKETPLACE_SELLER_READINESS_MAX_AGE_MS;

export type MarketplaceSellerReadinessClock = {
  now?: () => number;
  maxAgeMs?: number;
};

function assertSellerConnectionUsable(connection: SellerConnectionRecord): void {
  if (connection.consentStatus === 'revoked') {
    throw new PaymentReliabilityError(
      PAYMENT_RELIABILITY_ERROR.CAPABILITY_UNAVAILABLE,
      'Seller consent was revoked',
    );
  }
  if (connection.restricted) {
    throw new PaymentReliabilityError(
      PAYMENT_RELIABILITY_ERROR.CAPABILITY_UNAVAILABLE,
      'Seller account is restricted',
    );
  }
  if (!connection.providerMerchantId && !connection.trackingId) {
    throw new PaymentReliabilityError(
      PAYMENT_RELIABILITY_ERROR.CAPABILITY_UNAVAILABLE,
      'Seller merchant identity is not available',
    );
  }
}

export async function ensureSellerReadyForMarketplace(input: {
  store: PaymentReliabilityStore;
  sellerRecon: SellerConnectionReconciliationLookup;
  applicationRef: string;
  providerCode: string;
  accountRef: string;
  environment: 'sandbox' | 'live';
  sellerRef: string;
  now?: () => number;
  maxAgeMs?: number;
}): Promise<{ providerMerchantId: string; connection: SellerConnectionRecord }> {
  const now = input.now ?? Date.now;
  const maxAgeMs = input.maxAgeMs ?? MARKETPLACE_SELLER_READINESS_MAX_AGE_MS;

  let connection = await input.store.findSellerConnectionBySellerRef(
    input.applicationRef,
    input.providerCode,
    input.accountRef,
    input.environment,
    input.sellerRef,
  );
  if (!connection) {
    throw new PaymentReliabilityError(
      PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
      `Seller connection was not found for sellerRef "${input.sellerRef}"`,
    );
  }

  assertSellerConnectionUsable(connection);

  const merchantId = connection.providerMerchantId;
  const freshEvidence =
    merchantId != null
      ? await input.store.findLatestReconciliationEvidenceForResource({
          applicationRef: input.applicationRef,
          providerCode: input.providerCode,
          accountRef: input.accountRef,
          environment: input.environment,
          resourceId: merchantId,
        })
      : null;
  const connectionEvidence = await input.store.findLatestReconciliationEvidenceForResource({
    applicationRef: input.applicationRef,
    providerCode: input.providerCode,
    accountRef: input.accountRef,
    environment: input.environment,
    resourceId: connection.connectionId,
  });
  const latestEvidence = [freshEvidence, connectionEvidence]
    .filter((row): row is NonNullable<typeof row> => row != null)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  const isFresh =
    latestEvidence != null &&
    connection.readinessReady &&
    now() - Date.parse(latestEvidence.createdAt) <= maxAgeMs;

  if (!isFresh) {
    const recon = await reconcileSellerConnectionAggregate({
      store: input.store,
      providerLookup: input.sellerRecon,
      connection,
    });
    connection = recon.connection;
    if (
      recon.outcome === 'retryable_failure' ||
      recon.outcome === 'ambiguous' ||
      recon.outcome === 'not_found'
    ) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.CAPABILITY_UNAVAILABLE,
        'Seller readiness could not be verified',
      );
    }
    assertSellerConnectionUsable(connection);
    if (!connection.readinessReady) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.CAPABILITY_UNAVAILABLE,
        'Seller is not ready for marketplace checkout',
      );
    }
  }

  if (!connection.providerMerchantId) {
    throw new PaymentReliabilityError(
      PAYMENT_RELIABILITY_ERROR.CAPABILITY_UNAVAILABLE,
      'Seller merchant id is missing after readiness check',
    );
  }

  return { providerMerchantId: connection.providerMerchantId, connection };
}
