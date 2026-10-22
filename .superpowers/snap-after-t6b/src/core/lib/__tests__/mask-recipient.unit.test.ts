import { describe, expect, it } from 'vitest';
import { maskRecipientValue } from '../mask-recipient';

describe('maskRecipientValue', () => {
  it('masks email, phone, and PayPal id without echoing full values', () => {
    expect(maskRecipientValue('EMAIL', 'payee@example.com')).toBe('pa***@example.com');
    expect(maskRecipientValue('PHONE', '+1 (555) 123-4567')).toBe('***4567');
    expect(maskRecipientValue('PAYPAL_ID', 'ABCD1234EF')).toBe('ABCD***EF');
  });
});
