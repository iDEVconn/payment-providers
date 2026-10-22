import { describe, expect, it } from 'vitest';
import {
  extractPaypalCheckoutApprovalUrl,
  isAllowedPaypalApprovalUrl,
} from '../paypal-checkout-approval-url';

describe('paypal checkout approval url', () => {
  it('accepts payer-action on sandbox host', () => {
    const url = extractPaypalCheckoutApprovalUrl(
      [
        {
          rel: 'payer-action',
          href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1',
        },
      ],
      'sandbox',
    );
    expect(url).toBe('https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1');
  });

  it('accepts legacy approve links on sandbox host', () => {
    const url = extractPaypalCheckoutApprovalUrl(
      [{ rel: 'approve', href: 'https://sandbox.paypal.com/checkoutnow?token=ORDER-2' }],
      'sandbox',
    );
    expect(url).toBe('https://sandbox.paypal.com/checkoutnow?token=ORDER-2');
  });

  it('rejects live host in sandbox', () => {
    expect(
      isAllowedPaypalApprovalUrl('https://www.paypal.com/checkoutnow?token=ORDER-3', 'sandbox'),
    ).toBe(false);
  });

  it('rejects api hosts and non-https links', () => {
    expect(
      isAllowedPaypalApprovalUrl(
        'https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER-4',
        'sandbox',
      ),
    ).toBe(false);
    expect(isAllowedPaypalApprovalUrl('http://www.sandbox.paypal.com/x', 'sandbox')).toBe(false);
  });
});
