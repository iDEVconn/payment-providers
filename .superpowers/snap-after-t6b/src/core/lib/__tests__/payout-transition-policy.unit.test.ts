import { describe, expect, it } from 'vitest';
import {
  deriveBatchPayoutStatus,
  mapPayoutWebhookEventToFinancialStatus,
  mapPaypalItemTransactionStatus,
} from '../payout-transition-policy';

describe('payout transition policy', () => {
  it('maps PayPal item statuses and payout webhooks', () => {
    expect(mapPaypalItemTransactionStatus('SUCCESS')).toBe('succeeded');
    expect(mapPaypalItemTransactionStatus('UNCLAIMED')).toBe('unclaimed');
    expect(mapPayoutWebhookEventToFinancialStatus('PAYMENT.PAYOUTS-ITEM.RETURNED')).toBe(
      'returned',
    );
  });

  it('derives mixed batch aggregates without marking all items paid', () => {
    expect(deriveBatchPayoutStatus(['succeeded', 'failed'])).toBe('processing');
    expect(deriveBatchPayoutStatus(['succeeded', 'succeeded'])).toBe('succeeded');
    expect(deriveBatchPayoutStatus(['pending', 'pending'])).toBe('accepted');
  });
});
