import { describe, expect, it } from 'vitest';
import type { BillingCycleInput } from '../../../contracts/index';
import { validateBillingCycles } from '../subscription-billing-cycles';

const usd = (amountMinor: string) => ({ currency: 'USD', amountMinor });

describe('validateBillingCycles', () => {
  it('accepts unlimited regular cycle when totalCycles is zero', () => {
    expect(() =>
      validateBillingCycles([
        {
          tenureType: 'REGULAR',
          intervalUnit: 'MONTH',
          intervalCount: 1,
          sequence: 1,
          totalCycles: 0,
          price: { currency: 'USD', amountMinor: '700' },
        },
      ]),
    ).not.toThrow();
  });

  it('rejects trial cycles with zero totalCycles', () => {
    expect(() =>
      validateBillingCycles([
        {
          tenureType: 'TRIAL',
          intervalUnit: 'MONTH',
          intervalCount: 1,
          sequence: 1,
          totalCycles: 0,
        },
        {
          tenureType: 'REGULAR',
          intervalUnit: 'MONTH',
          intervalCount: 1,
          sequence: 2,
          totalCycles: 0,
          price: { currency: 'USD', amountMinor: '700' },
        },
      ]),
    ).toThrow();
  });

  it('accepts one regular cycle and up to two trial cycles', () => {
    expect(() =>
      validateBillingCycles([
        {
          tenureType: 'TRIAL',
          intervalUnit: 'MONTH',
          intervalCount: 1,
          sequence: 1,
          totalCycles: 1,
        },
        {
          tenureType: 'REGULAR',
          intervalUnit: 'MONTH',
          intervalCount: 1,
          sequence: 2,
          totalCycles: 1,
          price: { currency: 'USD', amountMinor: '999' },
        },
      ]),
    ).not.toThrow();
  });

  it('rejects duplicate or unordered sequences', () => {
    expect(() =>
      validateBillingCycles([
        {
          tenureType: 'REGULAR',
          intervalUnit: 'MONTH',
          intervalCount: 1,
          sequence: 2,
          totalCycles: 0,
          price: { currency: 'USD', amountMinor: '999' },
        },
        {
          tenureType: 'TRIAL',
          intervalUnit: 'MONTH',
          intervalCount: 1,
          sequence: 2,
          totalCycles: 1,
        },
      ]),
    ).toThrow();
  });

  it('rejects more than two trial cycles', () => {
    expect(() =>
      validateBillingCycles([
        {
          tenureType: 'TRIAL',
          intervalUnit: 'MONTH',
          intervalCount: 1,
          sequence: 1,
          totalCycles: 1,
        },
        {
          tenureType: 'TRIAL',
          intervalUnit: 'MONTH',
          intervalCount: 1,
          sequence: 2,
          totalCycles: 1,
        },
        {
          tenureType: 'TRIAL',
          intervalUnit: 'MONTH',
          intervalCount: 1,
          sequence: 3,
          totalCycles: 1,
        },
        {
          tenureType: 'REGULAR',
          intervalUnit: 'MONTH',
          intervalCount: 1,
          sequence: 4,
          totalCycles: 0,
          price: { currency: 'USD', amountMinor: '999' },
        },
      ]),
    ).toThrow();
  });
});

describe('validateBillingCycles pricing and order', () => {
  const regular = (sequence: number, price: BillingCycleInput['price'] = usd('999')) => ({
    tenureType: 'REGULAR' as const,
    intervalUnit: 'MONTH' as const,
    intervalCount: 1,
    sequence,
    totalCycles: 0,
    ...(price ? { price } : {}),
  });
  const trial = (sequence: number, price?: BillingCycleInput['price']) => ({
    tenureType: 'TRIAL' as const,
    intervalUnit: 'WEEK' as const,
    intervalCount: 1,
    sequence,
    totalCycles: 1,
    ...(price ? { price } : {}),
  });

  it('rejects a regular cycle without a price', () => {
    expect(() => validateBillingCycles([regular(1, null)])).toThrow(/price/i);
  });

  it('rejects a regular cycle with a zero price', () => {
    expect(() => validateBillingCycles([regular(1, usd('0'))])).toThrow();
  });

  it('accepts a free trial with no price or a zero price before the regular cycle', () => {
    expect(() => validateBillingCycles([trial(1), regular(2)])).not.toThrow();
    expect(() => validateBillingCycles([trial(1, usd('0')), regular(2)])).not.toThrow();
  });

  it('rejects a negative or malformed trial price', () => {
    expect(() => validateBillingCycles([trial(1, usd('-1')), regular(2)])).toThrow();
    expect(() => validateBillingCycles([trial(1, usd('1.5')), regular(2)])).toThrow();
    expect(() =>
      validateBillingCycles([trial(1, { currency: 'US', amountMinor: '0' }), regular(2)]),
    ).toThrow();
  });

  it('rejects a trial that comes after the regular cycle', () => {
    expect(() => validateBillingCycles([regular(1), trial(2, usd('100'))])).toThrow(/trial/i);
    expect(() => validateBillingCycles([regular(1), trial(2)])).toThrow(/trial/i);
  });

  it('rejects a trial that follows the regular cycle even when another trial precedes it', () => {
    expect(() => validateBillingCycles([trial(1), regular(2), trial(3)])).toThrow(/trial/i);
  });

  it('requires contiguous sequences starting at 1', () => {
    expect(() => validateBillingCycles([trial(1), regular(3)])).toThrow(/contiguous/i);
    expect(() => validateBillingCycles([trial(2), regular(3)])).toThrow(/contiguous/i);
    expect(() => validateBillingCycles([regular(2)])).toThrow(/contiguous/i);
  });

  it('returns cycles sorted by sequence', () => {
    const sorted = validateBillingCycles([regular(2), trial(1)]);
    expect(sorted.map((cycle) => cycle.sequence)).toEqual([1, 2]);
    expect(sorted.map((cycle) => cycle.tenureType)).toEqual(['TRIAL', 'REGULAR']);
  });
});
