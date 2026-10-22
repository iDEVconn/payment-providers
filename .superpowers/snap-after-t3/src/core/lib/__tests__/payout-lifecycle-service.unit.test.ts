import { describe, expect, it } from 'vitest';
import {
  PAYMENT_CAPABILITY_UNAVAILABLE,
  PAYMENT_RELIABILITY_ERROR,
} from '../../../contracts/index';
import type { PayoutProviderPort } from '../payout-provider-port';
import { PayoutLifecycleService } from '../payout-lifecycle-service';
import { MemoryPaymentReliabilityStore } from '../persistence/memory-payment-reliability-store';

const provider: PayoutProviderPort = {
  submitBatch: async (input) => ({
    senderBatchId: input.senderBatchId,
    providerPayoutBatchId: 'PAYPAL-BATCH-1',
    batchPayoutStatus: 'accepted',
    items: input.items.map((item) => ({
      senderItemId: item.senderItemId,
      providerPayoutItemId: `${item.senderItemId}-provider`,
      payoutStatus: 'pending',
      providerTransactionId: null,
      providerFee: null,
      failureCode: null,
      failureMessage: null,
    })),
  }),
  getBatch: async () => {
    throw new Error('not used');
  },
  getItem: async () => {
    throw new Error('not used');
  },
  cancelUnclaimedItem: async () => {
    throw new Error('not used');
  },
};

describe('PayoutLifecycleService', () => {
  it('creates batch/items and keeps items pending after batch acceptance', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new PayoutLifecycleService(store, provider);
    const result = await service.submitPayoutBatch({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      idempotencyKey: 'batch-idem-1',
      items: [
        {
          itemRef: 'line-1',
          amount: { currency: 'USD', amountMinor: '1000' },
          recipient: {
            recipientType: 'EMAIL',
            receiver: 'payee@example.com',
          },
        },
      ],
    });

    expect(result.payoutStatus).toBe('accepted');
    expect(result.items[0]?.payoutStatus).toBe('pending');
    expect(result.items[0]?.maskedDestination).toBe('pa***@example.com');
    expect(result.items[0]?.maskedDestination).not.toContain('payee@example.com');
  });

  it('rejects idempotency conflicts without echoing recipient values', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new PayoutLifecycleService(store, provider);
    const base = {
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox' as const,
      idempotencyKey: 'batch-idem-2',
      items: [
        {
          itemRef: 'line-1',
          amount: { currency: 'USD', amountMinor: '1000' },
          recipient: {
            recipientType: 'EMAIL' as const,
            receiver: 'first@example.com',
          },
        },
      ],
    };
    await service.submitPayoutBatch(base);
    await expect(
      service.submitPayoutBatch({
        ...base,
        items: [
          {
            itemRef: 'line-1',
            amount: { currency: 'USD', amountMinor: '2000' },
            recipient: {
              recipientType: 'EMAIL',
              receiver: 'second@example.com',
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: PAYMENT_RELIABILITY_ERROR.IDEMPOTENCY_CONFLICT });
  });

  it('classifies CAPABILITY_UNAVAILABLE as terminal failed with preserved message', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new PayoutLifecycleService(store, {
      ...provider,
      submitBatch: async () => {
        throw {
          code: PAYMENT_CAPABILITY_UNAVAILABLE,
          capability: 'payout',
          unavailableReason: 'Capability is disabled by configuration',
          message:
            'Payment capability "payout" is unavailable: Capability is disabled by configuration',
        };
      },
    });
    const result = await service.submitPayoutBatch({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      idempotencyKey: 'batch-capability-off',
      items: [
        {
          itemRef: 'line-1',
          amount: { currency: 'USD', amountMinor: '1000' },
          recipient: {
            recipientType: 'EMAIL',
            receiver: 'payee@example.com',
          },
        },
      ],
    });

    expect(result.payoutStatus).toBe('failed');
    expect(result.items[0]?.payoutStatus).toBe('failed');
    expect(result.items[0]?.failureCode).toBe(PAYMENT_CAPABILITY_UNAVAILABLE);
    expect(result.items[0]?.failureMessage).toBe('Capability is disabled by configuration');
  });

  it('keeps uncertain provider failures reserved as unknown', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new PayoutLifecycleService(store, {
      ...provider,
      submitBatch: async () => {
        throw {
          code: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
          message: 'PayPal payout submission returned uncertain outcome',
          uncertain: true,
          retryable: true,
        };
      },
    });
    const result = await service.submitPayoutBatch({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      idempotencyKey: 'batch-uncertain',
      items: [
        {
          itemRef: 'line-1',
          amount: { currency: 'USD', amountMinor: '1000' },
          recipient: {
            recipientType: 'EMAIL',
            receiver: 'payee@example.com',
          },
        },
      ],
    });

    expect(result.payoutStatus).toBe('unknown');
    expect(result.items[0]?.failureCode).toBe(PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN);
  });
});
