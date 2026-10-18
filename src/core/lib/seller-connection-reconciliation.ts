import {
  PAYMENT_RELIABILITY_ERROR,
  type ProviderEvidenceRecord,
  type SellerConnectionRecord,
  type SellerConnectionResult,
} from '../../contracts/index';
import { applySellerMerchantStatus } from './seller-evidence-application';
import { readinessFromConnection } from './seller-connection-readiness';
import type { ReconciliationProviderLookup } from './checkout-provider-port';
import type { PaymentReliabilityStore } from './persistence/payment-reliability-store';
import { sha256Payload } from './persistence/memory-payment-reliability-store';

export type SellerConnectionReconcileResult = {
  outcome: 'applied' | 'no_op' | 'retryable_failure' | 'ambiguous' | 'not_found';
  connection: SellerConnectionRecord;
  evidenceId?: string;
};

export type SellerConnectionReconciliationLookup = Pick<
  ReconciliationProviderLookup,
  'findMerchantByTrackingId' | 'getMerchantStatus'
>;

function toConnectionResult(connection: SellerConnectionRecord): SellerConnectionResult {
  return {
    connectionId: connection.connectionId,
    sellerRef: connection.sellerRef,
    trackingId: connection.trackingId,
    providerReferralId: connection.providerReferralId,
    providerMerchantId: connection.providerMerchantId,
    connectionStatus: connection.connectionStatus,
    consentStatus: connection.consentStatus,
    readiness: readinessFromConnection(connection),
    latestReferralOperationId: connection.latestReferralOperationId,
  };
}

async function insertConnectionReconciliationEvidence(
  store: PaymentReliabilityStore,
  connection: SellerConnectionRecord,
  input: { eventType: string; resourceId: string | null },
): Promise<ProviderEvidenceRecord> {
  const rawPayload = JSON.stringify({
    connectionId: connection.connectionId,
    sellerRef: connection.sellerRef,
    trackingId: connection.trackingId,
    resourceId: input.resourceId,
    eventType: input.eventType,
  });
  const evidence = await store.insertEvidence({
    providerCode: connection.providerCode,
    accountRef: connection.accountRef,
    applicationRef: connection.applicationRef,
    environment: connection.environment,
    evidenceKind: 'reconciliation',
    providerEventId: `reconcile-connection-${connection.connectionId}-${Date.now()}`,
    rawPayload,
    payloadSha256: sha256Payload(rawPayload),
    eventType: input.eventType,
    resourceId: input.resourceId,
  });
  return store.updateEvidence({
    evidenceId: evidence.evidenceId,
    verificationStatus: 'verified',
    processingStatus: 'pending',
  });
}

function providerContext(connection: SellerConnectionRecord) {
  return {
    providerCode: connection.providerCode,
    accountRef: connection.accountRef,
    applicationRef: connection.applicationRef,
    environment: connection.environment,
  };
}

/**
 * Read-only seller-connection reconciliation: tracking lookup and merchant-status GET only.
 * Never creates a referral or duplicate connection aggregate.
 */
export async function reconcileSellerConnectionAggregate(input: {
  store: PaymentReliabilityStore;
  providerLookup: SellerConnectionReconciliationLookup;
  connection: SellerConnectionRecord;
}): Promise<SellerConnectionReconcileResult> {
  let connection = input.connection;
  const context = providerContext(connection);

  try {
    let merchantId = connection.providerMerchantId;

    if (!merchantId && connection.trackingId.trim()) {
      const found = await input.providerLookup.findMerchantByTrackingId({
        ...context,
        trackingId: connection.trackingId,
      });
      if (found.ambiguous || (found.matchCount !== undefined && found.matchCount > 1)) {
        const evidence = await insertConnectionReconciliationEvidence(input.store, connection, {
          eventType: 'RECONCILIATION.SELLER_CONNECTION.AMBIGUOUS_TRACKING',
          resourceId: connection.trackingId,
        });
        await input.store.insertReconciliationAttempt({
          evidenceId: evidence.evidenceId,
          operationId: null,
          outcome: 'no_op',
          resultCode: 'AMBIGUOUS_TRACKING',
          resultMessage: 'Multiple merchant matches for tracking id',
        });
        await input.store.updateEvidence({
          evidenceId: evidence.evidenceId,
          processingStatus: 'processed',
          processedAt: new Date().toISOString(),
        });
        return { outcome: 'ambiguous', connection, evidenceId: evidence.evidenceId };
      }
      merchantId = found.providerMerchantId;
      if (!merchantId) {
        const evidence = await insertConnectionReconciliationEvidence(input.store, connection, {
          eventType: 'RECONCILIATION.SELLER_CONNECTION.MERCHANT_NOT_FOUND',
          resourceId: connection.trackingId,
        });
        await input.store.insertReconciliationAttempt({
          evidenceId: evidence.evidenceId,
          operationId: null,
          outcome: 'no_op',
          resultCode: 'MERCHANT_NOT_FOUND',
          resultMessage: 'No merchant id resolved for tracking id',
        });
        await input.store.updateEvidence({
          evidenceId: evidence.evidenceId,
          processingStatus: 'processed',
          processedAt: new Date().toISOString(),
        });
        return { outcome: 'not_found', connection, evidenceId: evidence.evidenceId };
      }
      connection = await input.store.updateSellerConnection({
        connectionId: connection.connectionId,
        expectedVersion: connection.version,
        providerMerchantId: merchantId,
        connectionStatus:
          connection.connectionStatus === 'referral_created'
            ? 'onboarding_pending'
            : connection.connectionStatus,
      });
    }

    if (!merchantId) {
      const evidence = await insertConnectionReconciliationEvidence(input.store, connection, {
        eventType: 'RECONCILIATION.SELLER_CONNECTION.MISSING_MERCHANT_ID',
        resourceId: null,
      });
      await input.store.insertReconciliationAttempt({
        evidenceId: evidence.evidenceId,
        operationId: null,
        outcome: 'no_op',
        resultCode: 'MISSING_MERCHANT_ID',
        resultMessage: 'Seller connection has no merchant id or tracking id',
      });
      await input.store.updateEvidence({
        evidenceId: evidence.evidenceId,
        processingStatus: 'processed',
        processedAt: new Date().toISOString(),
      });
      return { outcome: 'no_op', connection, evidenceId: evidence.evidenceId };
    }

    const evidence = await insertConnectionReconciliationEvidence(input.store, connection, {
      eventType: 'RECONCILIATION.SELLER_CONNECTION.MERCHANT_STATUS',
      resourceId: merchantId,
    });

    const snapshot = await input.providerLookup.getMerchantStatus({
      ...context,
      providerMerchantId: merchantId,
    });

    connection = await applySellerMerchantStatus({
      store: input.store,
      connection,
      snapshot,
    });

    await input.store.insertReconciliationAttempt({
      evidenceId: evidence.evidenceId,
      operationId: null,
      outcome: 'applied',
      resultCode: 'APPLIED',
    });
    await input.store.updateEvidence({
      evidenceId: evidence.evidenceId,
      processingStatus: 'processed',
      processedAt: new Date().toISOString(),
    });

    return { outcome: 'applied', connection, evidenceId: evidence.evidenceId };
  } catch (error) {
    const err = error as { code?: string; retryable?: boolean; uncertain?: boolean };
    const retryable =
      err?.code === PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN ||
      err?.retryable ||
      err?.uncertain;
    const evidence = await insertConnectionReconciliationEvidence(input.store, connection, {
      eventType: retryable
        ? 'RECONCILIATION.SELLER_CONNECTION.RETRYABLE'
        : 'RECONCILIATION.SELLER_CONNECTION.FAILED',
      resourceId: connection.providerMerchantId ?? connection.trackingId,
    });
    await input.store.insertReconciliationAttempt({
      evidenceId: evidence.evidenceId,
      operationId: null,
      outcome: retryable ? 'retryable_failure' : 'no_op',
      resultCode: retryable ? 'RETRYABLE' : 'FAILED',
      resultMessage: error instanceof Error ? error.message : 'Seller connection reconcile failed',
    });
    await input.store.updateEvidence({
      evidenceId: evidence.evidenceId,
      processingStatus: 'processed',
      processedAt: new Date().toISOString(),
    });
    return {
      outcome: retryable ? 'retryable_failure' : 'no_op',
      connection,
      evidenceId: evidence.evidenceId,
    };
  }
}

export function sellerConnectionResultFromRecord(
  connection: SellerConnectionRecord,
): SellerConnectionResult {
  return toConnectionResult(connection);
}
