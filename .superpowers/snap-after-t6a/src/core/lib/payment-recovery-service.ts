import {
  PAYMENT_RELIABILITY_ERROR,
  PaymentReliabilityError,
  type ProviderEvidenceRecord,
  type RecoverPaymentEvidenceInput,
  type RecoverPaymentEvidenceResult,
  type RecoverPaymentReliabilityInput,
  type RecoverPaymentReliabilityResult,
} from '../../contracts/index';
import { PaymentConfigurationError } from './payment-configuration-error';
import { sanitizeOperationalErrorMessage } from './public-error-sanitizer';
import { isConsumerDeliveryComplete } from './webhook-evidence-resume';

const CONSUMER_DELIVERY_FAILURE_MESSAGE = 'Consumer event delivery failed';
export { isRecoverableEvidenceRow } from './webhook-evidence-resume';
import {
  toVerifiedProcessedPaymentEvent,
  type PaymentEventConsumer,
} from './payment-event-consumer';
import type { EvidenceStore } from './persistence/payment-reliability-store';
import type { WebhookProcessingService } from './webhook-processing-service';

/** Failed consumer deliveries per evidence row before it becomes `failed_terminal`. */
export const DEFAULT_MAX_CONSUMER_DELIVERY_ATTEMPTS = 10;

export type PaymentRecoveryDependencies = {
  store: EvidenceStore;
  webhookProcessing: WebhookProcessingService;
  /**
   * Receives each processed event at least once (a failed acknowledgement write delivers it again),
   * so it must be idempotent on `providerEventId`. `null`: rows are processed but never claimed for
   * delivery; their delivery stays `pending`.
   */
  consumer: PaymentEventConsumer | null;
  /**
   * Failed deliveries after which a row gets `consumerDeliveryStatus: 'failed_terminal'` and is no
   * longer claimed. Default `DEFAULT_MAX_CONSUMER_DELIVERY_ATTEMPTS`; must be an integer >= 1.
   */
  maxConsumerDeliveryAttempts?: number;
  /** Pass the stored raw provider body to the consumer as `rawPayload`. Default false. */
  includeRawPayload?: boolean;
};

export class PaymentRecoveryService {
  private readonly maxConsumerDeliveryAttempts: number;

  constructor(private readonly deps: PaymentRecoveryDependencies) {
    const max = deps.maxConsumerDeliveryAttempts ?? DEFAULT_MAX_CONSUMER_DELIVERY_ATTEMPTS;
    if (!Number.isInteger(max) || max < 1) {
      throw new PaymentConfigurationError(
        'Payment recovery option maxConsumerDeliveryAttempts must be an integer of at least 1',
        ['maxConsumerDeliveryAttempts'],
      );
    }
    this.maxConsumerDeliveryAttempts = max;
  }

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
      includeConsumerDelivery: this.deps.consumer !== null,
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
      !isConsumerDeliveryComplete(evidence)
    ) {
      return (await this.tryDeliverConsumer(evidence.evidenceId)) ? 'delivered' : 'skipped';
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

  /** Delivers once; `true` only when the consumer received the event and it was acknowledged. */
  private async tryDeliverConsumer(evidenceId: string): Promise<boolean> {
    if (!this.deps.consumer) {
      return false;
    }
    const fresh = await this.deps.store.findEvidenceById(evidenceId);
    if (
      !fresh ||
      fresh.verificationStatus !== 'verified' ||
      fresh.processingStatus !== 'processed'
    ) {
      return false;
    }
    if (isConsumerDeliveryComplete(fresh)) {
      return false;
    }
    const attempts = fresh.consumerDeliveryAttempts ?? 0;
    if (attempts >= this.maxConsumerDeliveryAttempts) {
      await this.deps.store.updateEvidence({
        evidenceId,
        consumerDeliveryStatus: 'failed_terminal',
      });
      return false;
    }

    try {
      await this.deps.consumer.deliver(
        toVerifiedProcessedPaymentEvent(fresh, { includeRawPayload: this.deps.includeRawPayload }),
      );
      await this.deps.store.updateEvidence({
        evidenceId,
        consumerDeliveryStatus: 'confirmed',
        consumerDeliveredAt: new Date().toISOString(),
        consumerDeliveryLastError: null,
      });
      return true;
    } catch (error) {
      sanitizeOperationalErrorMessage(error, CONSUMER_DELIVERY_FAILURE_MESSAGE);
      const failedAttempts = attempts + 1;
      await this.deps.store.updateEvidence({
        evidenceId,
        consumerDeliveryStatus:
          failedAttempts >= this.maxConsumerDeliveryAttempts ? 'failed_terminal' : 'failed',
        consumerDeliveryAttempts: failedAttempts,
        consumerDeliveryLastError: CONSUMER_DELIVERY_FAILURE_MESSAGE,
      });
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.PERSISTENCE_FAILURE,
        CONSUMER_DELIVERY_FAILURE_MESSAGE,
      );
    }
  }
}
