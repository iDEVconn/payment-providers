import {
  PAYMENT_RELIABILITY_ERROR,
  PaymentReliabilityError,
  type CreateSellerReferralRequest,
  type GetSellerConnectionRequest,
  type GetSellerReferralRequest,
  type PaymentOperation,
  type ReconcileSellerConnectionRequest,
  type SellerConnectionRecord,
  type SellerConnectionResult,
  type SellerReferralResult,
} from '../../contracts/index';
import { buildCommandFingerprint } from './command-fingerprint';
import { buildOperationIdempotencyScope } from './operation-idempotency';
import { readinessFromConnection } from './seller-connection-readiness';
import {
  reconcileSellerConnectionAggregate,
  sellerConnectionResultFromRecord,
} from './seller-connection-reconciliation';
import type { SellerOnboardingProviderPort } from './seller-onboarding-provider-port';
import type { PaymentReliabilityStore } from './persistence/payment-reliability-store';

function isTerminal(status: PaymentOperation['status']): boolean {
  return status === 'succeeded' || status === 'failed';
}

function toReferralResult(
  operation: PaymentOperation,
  connection: SellerConnectionRecord,
  providerDebugId?: string | null,
): SellerReferralResult {
  return {
    referralOperationId: operation.operationId,
    connectionId: connection.connectionId,
    operationStatus: operation.status,
    connectionStatus: connection.connectionStatus,
    providerReferralId: operation.providerReferralId ?? connection.providerReferralId,
    actionUrl: operation.approvalUrl,
    sellerRef: operation.sellerRef ?? connection.sellerRef,
    correlationId: operation.correlationId,
    providerDebugId: providerDebugId ?? null,
  };
}

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

export class SellerOnboardingLifecycleService {
  constructor(
    private readonly store: PaymentReliabilityStore,
    private readonly provider: SellerOnboardingProviderPort,
  ) {}

  async createSellerReferral(input: CreateSellerReferralRequest): Promise<SellerReferralResult> {
    const sellerRef = input.sellerRef.trim();
    if (!sellerRef) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.TRANSITION_REJECTED,
        'sellerRef is required',
      );
    }
    const fingerprint = buildCommandFingerprint({ sellerRef });
    const scope = buildOperationIdempotencyScope({
      applicationRef: input.applicationRef,
      accountRef: input.accountRef,
      environment: input.environment,
      kind: 'seller_referral',
    });

    let operation = await this.store.createOperation({
      idempotencyKey: input.idempotencyKey,
      idempotencyScope: scope,
      commandFingerprint: fingerprint,
      providerCode: input.providerCode,
      accountRef: input.accountRef,
      applicationRef: input.applicationRef,
      environment: input.environment,
      kind: 'seller_referral',
      correlationId: input.correlationId ?? null,
      sellerRef,
    });

    let connection =
      (await this.store.findSellerConnectionBySellerRef(
        input.applicationRef,
        input.providerCode,
        input.accountRef,
        input.environment,
        sellerRef,
      )) ??
      (await this.store.createSellerConnection({
        applicationRef: input.applicationRef,
        providerCode: input.providerCode,
        accountRef: input.accountRef,
        environment: input.environment,
        sellerRef,
        trackingId: sellerRef,
        latestReferralOperationId: operation.operationId,
      }));

    if (
      isTerminal(operation.status) ||
      operation.status === 'submitted' ||
      operation.status === 'unknown'
    ) {
      return toReferralResult(operation, connection);
    }

    operation = await this.store.claimOperationForExecution({
      operationId: operation.operationId,
      expectedVersion: operation.version,
    });

    try {
      const result = await this.provider.createReferral({
        providerCode: input.providerCode,
        accountRef: input.accountRef,
        applicationRef: input.applicationRef,
        environment: input.environment,
        providerRequestId: operation.operationId,
        trackingId: connection.trackingId,
      });
      operation = await this.store.transitionOperation({
        operationId: operation.operationId,
        expectedVersion: operation.version,
        nextStatus: 'succeeded',
        providerReferralId: result.providerReferralId,
        providerReferenceId: result.providerReferralId,
        approvalUrl: result.actionUrl,
        sellerRef,
        reason: 'seller_referral_created',
      });
      connection = await this.store.updateSellerConnection({
        connectionId: connection.connectionId,
        expectedVersion: connection.version,
        latestReferralOperationId: operation.operationId,
        providerReferralId: result.providerReferralId,
      });
      return toReferralResult(operation, connection, result.providerDebugId);
    } catch (error) {
      const latest = await this.store.findOperationById(operation.operationId);
      if (latest) {
        await this.store.transitionOperation({
          operationId: latest.operationId,
          expectedVersion: latest.version,
          nextStatus: 'failed',
          failureMessage: error instanceof Error ? error.message : 'Seller referral failed',
          reason: 'seller_referral_failed',
        });
      }
      throw error;
    }
  }

  async getSellerReferral(input: GetSellerReferralRequest): Promise<SellerReferralResult> {
    const operation = await this.store.findOperationById(input.referralOperationId);
    if (!operation || operation.kind !== 'seller_referral') {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.TRANSITION_CONFLICT,
        'Seller referral was not found',
      );
    }
    const connection = operation.sellerRef
      ? await this.store.findSellerConnectionBySellerRef(
          input.applicationRef,
          input.providerCode,
          input.accountRef,
          input.environment,
          operation.sellerRef,
        )
      : operation.providerReferralId
        ? await this.store.findSellerConnectionByReferralId(
            input.providerCode,
            input.accountRef,
            input.environment,
            operation.providerReferralId,
          )
        : null;
    if (!connection || !operation.providerReferralId) {
      return toReferralResult(
        operation,
        connection ??
          (await this.requireConnection(
            input.applicationRef,
            input.providerCode,
            input.accountRef,
            input.environment,
            operation.sellerRef ?? '',
          )),
      );
    }
    const refreshed = await this.provider.getReferral({
      providerCode: input.providerCode,
      accountRef: input.accountRef,
      applicationRef: input.applicationRef,
      environment: input.environment,
      providerReferralId: operation.providerReferralId,
    });
    const updated = await this.store.updateOperation({
      operationId: operation.operationId,
      expectedVersion: operation.version,
      approvalUrl: refreshed.actionUrl,
      providerReferralId: refreshed.providerReferralId,
    });
    return toReferralResult(updated, connection, refreshed.providerDebugId);
  }

  async getSellerConnection(input: GetSellerConnectionRequest): Promise<SellerConnectionResult> {
    const connection = await this.requireConnection(
      input.applicationRef,
      input.providerCode,
      input.accountRef,
      input.environment,
      input.sellerRef,
    );
    return toConnectionResult(connection);
  }

  async reconcileSellerConnection(
    input: ReconcileSellerConnectionRequest,
  ): Promise<SellerConnectionResult> {
    const connection = await this.requireConnection(
      input.applicationRef,
      input.providerCode,
      input.accountRef,
      input.environment,
      input.sellerRef,
    );
    const result = await reconcileSellerConnectionAggregate({
      store: this.store,
      providerLookup: this.provider,
      connection,
    });
    return sellerConnectionResultFromRecord(result.connection);
  }

  private async requireConnection(
    applicationRef: string,
    providerCode: string,
    accountRef: string,
    environment: string,
    sellerRef: string,
  ): Promise<SellerConnectionRecord> {
    const connection = await this.store.findSellerConnectionBySellerRef(
      applicationRef,
      providerCode,
      accountRef,
      environment,
      sellerRef,
    );
    if (!connection) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.TRANSITION_CONFLICT,
        'Seller connection was not found',
      );
    }
    return connection;
  }
}
