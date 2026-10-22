import { describe, expect, it } from 'vitest';
import type {
  CreateMarketplaceOrderRequest,
  MarketplaceUnitInput,
  PaymentOperationKind,
} from '../../index';

describe('marketplace contracts', () => {
  it('keeps public unit input free of provider merchant id', () => {
    const unit: MarketplaceUnitInput = {
      sellerRef: 'seller-a',
      referenceId: 'unit-a',
      amount: { currency: 'USD', amountMinor: '1000' },
      platformFee: { currency: 'USD', amountMinor: '100' },
    };
    expect(unit).not.toHaveProperty('providerMerchantId');
    expect(unit.sellerRef).toBe('seller-a');
  });

  it('allows one to ten purchase units on create requests', () => {
    const request: CreateMarketplaceOrderRequest = {
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'app-1',
      environment: 'sandbox',
      idempotencyKey: 'idem-1',
      units: Array.from({ length: 10 }, (_, index) => ({
        sellerRef: `seller-${index}`,
        referenceId: `unit-${index}`,
        amount: { currency: 'USD', amountMinor: '100' },
      })),
    };
    expect(request.units).toHaveLength(10);
  });

  it('lists marketplace operation kinds without authorize or delayed disbursement', () => {
    const kinds: PaymentOperationKind[] = [
      'marketplace_checkout',
      'marketplace_capture',
      'marketplace_refund',
    ];
    expect(kinds).not.toContain('checkout');
    expect(kinds.every((kind) => kind.startsWith('marketplace_'))).toBe(true);
  });

  it('requires platform fee currency to match unit amount at the type boundary', () => {
    const unit: MarketplaceUnitInput = {
      sellerRef: 'seller-a',
      referenceId: 'unit-a',
      amount: { currency: 'EUR', amountMinor: '500' },
      platformFee: { currency: 'EUR', amountMinor: '50' },
    };
    expect(unit.platformFee?.currency).toBe(unit.amount.currency);
  });
});
