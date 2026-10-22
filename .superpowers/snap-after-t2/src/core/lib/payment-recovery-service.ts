import {
  PAYMENT_RELIABILITY_ERROR,
  PaymentReliabilityError,
  type ProviderEvidenceRecord,
  type RecoverPaymentEvidenceInput,
  type RecoverPaymentEvidenceResult,
  type RecoverPaymentReliabilityInput,
  type RecoverPaymentReliabilityResult,
} from '../../contracts/index';
import { sanitizeOperationalErrorMessage } from './public-error-sanitizer';
import { isConsumerDeliveryComplete } from './webhook-evidence-resume';

const CONSUMER_DELIVERY_FAILURE_MESSAGE = 'Consumer event delivery failed';
export { isRecoverableEvidenceRow } from './webhook-evidence-resume';
import type { PaymentEventConsumer } from './payment-event-consumer';
import type { PaymentReliabilityStore } from './persistence/payment-reliability-store';
import type { WebhookProcessingService } from './webhook-processing-service';

export type PaymentRecoveryDependencies = {
  store: PaymentReliabilityStore;
  webhookProcessing: WebhookProcessingService;
  consumer: PaymentEventConsumer | null;
};

export class PaymentRecoveryService {
  constructor(private readonly deps: PaymentRecoveryDependencies) {}

  async recover(input: RecoverPaymentReliabilityInput): Promise<RecoverPaymentReliabilityResult> {
    const limit = input.limit ?? 25;
    const leaseMs = input.leaseMs ?? 60_000;
    const workerId = input.workerId.trim();

    const claimed = await this.deps.store.claimPendingEvidence({
      limit,
      leaseMs,
      workerId,
      evidenceIds: input.evidenceIds,
      environment: input.environment,
      providerCode: input.providerCode,
      accountRef: input.accountRef,
    });

    return this.executeRecoveryBatch(claimed);
  }

  async recoverEvidence(input: RecoverPaymentEvidenceInput): Promise<RecoverPaymentEvidenceResult> {
    const evidence = await this.deps.store.findEvidenceById(input.evidenceId);
    if (!evidence) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        `Evidence ${input.evidenceId} was not found`,
      );
    }
    this.assertEnvironmentMatch(evidence, input.environment);

    const batch = await this.recover({
      limit: 1,
      leaseMs: input.leaseMs,
      workerId: input.workerId,
      environment: input.environment,
      providerCode: evidence.providerCode,
      accountRef: evidence.accountRef,
      evidenceIds: [input.evidenceId],
    });

    return {
      evidenceId: input.evidenceId,
      ...batch,
    };
  }

  private async executeRecoveryBatch(
    claimed: ProviderEvidenceRecord[],
  ): Promise<RecoverPaymentReliabilityResult> {
    const summary: RecoverPaymentReliabilityResult = {
      claimed: claimed.length,
      verified: 0,
      processed: 0,
      delivered: 0,
      skipped: 0,
      failed: 0,
    };

    for (const row of claimed) {
      try {
        const outcome = await this.recoverClaimedEvidence(row);
        summary[outcome] += 1;
      } catch {
        summary.failed += 1;
      } finally {
        await this.deps.store.updateEvidence({
          evidenceId: row.evidenceId,
          claimLeaseExpiresAt: null,
          claimWorkerId: null,
        });
      }
    }

    return summary;
  }

  private async recoverClaimedEvidence(
    evidence: ProviderEvidenceRecord,
  ): Promise<
    keyof Pick<RecoverPaymentReliabilityResult, 'verified' | 'processed' | 'delivered' | 'skipped'>
  > {
    if (evidence.verificationStatus === 'pending') {
      return 'skipped';
    }

    if (evidence.verificationStatus === 'verified' && evidence.processingStatus === 'pending') {
      const receipt = await this.deps.webhookProcessing.reprocessStoredWebhookEvidence(
        evidence.evidenceId,
      );
      if (receipt.processingStatus === 'processed') {
        await this.tryDeliverConsumer(evidence.evidenceId);
        return 'processed';
      }
      return 'skipped';
    }

    if (
      evidence.verificationStatus === 'verified' &&
      evidence.processingStatus === 'processed' &&
      evidence.consumerDeliveryStatus !== 'confirmed'
    ) {
      await this.tryDeliverConsumer(evidence.evidenceId);
      return 'delivered';
    }

    if (evidence.processingStatus === 'unmatched') {
      const receipt = await this.deps.webhookProcessing.reprocessStoredWebhookEvidence(
        evidence.evidenceId,
      );
      if (receipt.processingStatus === 'processed') {
        await this.tryDeliverConsumer(evidence.evidenceId);
        return 'processed';
      }
    }

    return 'skipped';
  }

  private assertEnvironmentMatch(
    evidence: ProviderEvidenceRecord,
    environment: RecoverPaymentEvidenceInput['environment'],
  ): void {
    if (evidence.environment !== environment) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        `Evidence environment "${evidence.environment}" does not match requested "${environment}"`,
      );
    }
  }

  private async tryDeliverConsumer(evidenceId: string): Promise<void> {
    if (!this.deps.consumer) {
      return;
    }
    const fresh = await this.deps.store.findEvidenceById(evidenceId);
    if (
      !fresh ||
      fresh.verificationStatus !== 'verified' ||
      fresh.processingStatus !== 'processed'
    ) {
      return;
    }
    if (isConsumerDeliveryComplete(fresh)) {
      return;
    }

    try {
      await this.deps.consumer.deliver(fresh);
      await this.deps.store.updateEvidence({
        evidenceId,
        consumerDeliveryStatus: 'confirmed',
        consumerDeliveredAt: new Date().toISOString(),
        consumerDeliveryLastError: null,
      });
    } catch (error) {
      sanitizeOperationalErrorMessage(error, CONSUMER_DELIVERY_FAILURE_MESSAGE);
      await this.deps.store.updateEvidence({
        evidenceId,
        consumerDeliveryStatus: 'failed',
        consumerDeliveryAttempts: (fresh.consumerDeliveryAttempts ?? 0) + 1,
        consumerDeliveryLastError: CONSUMER_DELIVERY_FAILURE_MESSAGE,
      });
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.PERSISTENCE_FAILURE,
        CONSUMER_DELIVERY_FAILURE_MESSAGE,
      );
    }
  }
}
