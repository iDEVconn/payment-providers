import { describe, expect, it } from 'vitest';
import { PaymentReliabilityError } from '../../../contracts/index';
import {
  canonicalMoneyToLegacyMajorAmount,
  minorUnitsToMajorString,
  validateCanonicalMoney,
} from '../money';

describe('money', () => {
  it('converts minor to major exactly for USD', () => {
    expect(minorUnitsToMajorString('999', 'USD')).toBe('9.99');
    expect(canonicalMoneyToLegacyMajorAmount({ currency: 'USD', amountMinor: '140000' })).toBe(
      '1400.00',
    );
  });

  it('rejects fractional minor units for USD', () => {
    expect(() => validateCanonicalMoney({ currency: 'USD', amountMinor: '9.9' })).toThrow(
      PaymentReliabilityError,
    );
  });

  it('rejects negative and zero amounts', () => {
    expect(() => validateCanonicalMoney({ currency: 'USD', amountMinor: '-1' })).toThrow(
      PaymentReliabilityError,
    );
    expect(() => validateCanonicalMoney({ currency: 'USD', amountMinor: '0' })).toThrow(
      PaymentReliabilityError,
    );
  });

  it('rejects scientific notation', () => {
    expect(() => validateCanonicalMoney({ currency: 'USD', amountMinor: '1e3' })).toThrow(
      PaymentReliabilityError,
    );
  });
});
