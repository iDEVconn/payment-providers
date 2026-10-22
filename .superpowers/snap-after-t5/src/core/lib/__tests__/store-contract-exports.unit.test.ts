import { describe, expect, it } from 'vitest';
import type {
  CheckoutStore,
  CreateExecutionLeaseStore,
  EvidenceAdminStore,
  EvidenceStore,
  MarketplaceStore,
  OperationStore,
  PaymentReliabilityStore,
  PayoutStore,
  ReconciliationStore,
  SellerStore,
  SubscriptionOperationLookupStore,
  SubscriptionStore,
} from '../../../index';
import { MemoryPaymentReliabilityStore } from '../persistence/memory-payment-reliability-store';

describe('store contract exports (issues #6, #23, #24)', () => {
  it('exports the runtime values from the root entry', async () => {
    const root = await import('../../../index');
    expect(root.OPERATION_TRANSITION_KIND).toEqual({
      CLAIM_EXECUTION: 'claim_execution',
      CLAIM_RETRY: 'claim_retry',
    });
    expect(root.DEFAULT_MAX_CONSUMER_DELIVERY_ATTEMPTS).toBe(10);
    expect(typeof root.toVerifiedProcessedPaymentEvent).toBe('function');
    expect(typeof root.isAwaitingConsumerDeliveryOnly).toBe('function');
  });

  it('keeps PaymentReliabilityStore the union of the capability interfaces', () => {
    const store: PaymentReliabilityStore = new MemoryPaymentReliabilityStore();
    const parts: [
      OperationStore,
      CreateExecutionLeaseStore,
      SubscriptionOperationLookupStore,
      EvidenceStore,
      ReconciliationStore,
      SubscriptionStore,
      CheckoutStore,
      PayoutStore,
      SellerStore,
      MarketplaceStore,
      EvidenceAdminStore,
    ] = [store, store, store, store, store, store, store, store, store, store, store];
    expect(parts.length).toBe(11);
  });
});
