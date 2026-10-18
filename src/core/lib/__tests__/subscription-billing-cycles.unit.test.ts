import { describe, expect, it } from 'vitest';
import { validateBillingCycles } from '../subscription-billing-cycles';

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
