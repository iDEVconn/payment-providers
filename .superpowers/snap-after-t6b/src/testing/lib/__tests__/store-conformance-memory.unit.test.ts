import { describe, expect, it } from 'vitest';
import { MemoryPaymentReliabilityStore } from '../../../core/lib/persistence/memory-payment-reliability-store';
import { runStoreConformance } from '../../index';

// The in-memory reference store must honour every guarantee the kit checks (issue #6).
runStoreConformance({
  createStore: () => new MemoryPaymentReliabilityStore(),
  describe,
  it,
  expect,
  capabilities: { checkout: true, payout: true, seller: true, marketplace: true },
});
