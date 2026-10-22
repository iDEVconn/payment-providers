import { describe, expect, it } from 'vitest';
import {
  mapPaypalCaptureStatus,
  mapPaypalOrderStatus,
  parsePurchaseUnitCaptures,
  resolveCheckoutStatusFromOrder,
} from '../paypal-checkout-order-parsing';

describe('paypal checkout order parsing', () => {
  it('maps PAYER_ACTION_REQUIRED to created', () => {
    expect(mapPaypalOrderStatus('PAYER_ACTION_REQUIRED')).toBe('created');
  });

  it('does not treat pending capture as captured', () => {
    const capture = parsePurchaseUnitCaptures([
      {
        payments: {
          captures: [
            { id: 'CAP-1', status: 'PENDING', amount: { currency_code: 'USD', value: '107.00' } },
          ],
        },
      },
    ]);
    expect(mapPaypalCaptureStatus(capture?.status)).toBe('unknown');
    expect(resolveCheckoutStatusFromOrder('COMPLETED', capture)).toBe('unknown');
  });

  it('treats completed capture as captured', () => {
    const capture = parsePurchaseUnitCaptures([
      {
        payments: {
          captures: [
            { id: 'CAP-2', status: 'COMPLETED', amount: { currency_code: 'USD', value: '107.00' } },
          ],
        },
      },
    ]);
    expect(mapPaypalCaptureStatus(capture?.status)).toBe('captured');
    expect(resolveCheckoutStatusFromOrder('COMPLETED', capture)).toBe('captured');
  });
});
