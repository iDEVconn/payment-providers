import { describe, expect, it } from 'vitest';
import { PaymentReliabilityError } from '../../../contracts/index';
import { currencyMinorUnitExponent } from '../../../subscription-core/lib/subscription-money';
import {
  canonicalMoneyToLegacyMajorAmount,
  currencyFractionDigits,
  majorUnitsToMinorString,
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

  it('uses the single ISO 4217 table shared with the subscription core', () => {
    for (const [currency, digits] of [
      ['USD', 2],
      ['JPY', 0],
      ['KRW', 0],
      ['BHD', 3],
      ['KWD', 3],
      [' usd ', 2],
      ['XYZ', 2],
    ] as const) {
      expect(currencyFractionDigits(currency)).toBe(digits);
      expect(currencyFractionDigits(currency)).toBe(currencyMinorUnitExponent(currency.trim()));
    }
  });

  it('converts KRW and BHD with their own exponents', () => {
    expect(minorUnitsToMajorString('1000', 'KRW')).toBe('1000');
    expect(minorUnitsToMajorString('10000', 'BHD')).toBe('10.000');
    expect(majorUnitsToMinorString('10.000', 'BHD')).toBe('10000');
    expect(majorUnitsToMinorString('1000', 'KRW')).toBe('1000');
  });
});
