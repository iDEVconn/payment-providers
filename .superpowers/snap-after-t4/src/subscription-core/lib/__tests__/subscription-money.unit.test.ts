import { describe, expect, it } from 'vitest';
import {
  currencyMinorUnitExponent,
  parseDecimalToMinorUnits,
  parseSignedDecimalToMinorUnits,
} from '../subscription-money';

describe('currencyMinorUnitExponent', () => {
  it.each([
    ['USD', 2],
    ['eur', 2],
    ['JPY', 0],
    ['KRW', 0],
    ['VND', 0],
    ['BHD', 3],
    ['KWD', 3],
    ['JOD', 3],
    ['OMR', 3],
    ['TND', 3],
    ['XYZ', 2],
  ])('%s -> %i', (currency, exponent) => {
    expect(currencyMinorUnitExponent(currency)).toBe(exponent);
  });
});

describe('parseDecimalToMinorUnits', () => {
  it.each([
    ['10.00', 'USD', '1000'],
    ['10', 'USD', '1000'],
    ['10.5', 'USD', '1050'],
    ['0.01', 'USD', '1'],
    ['0', 'USD', '0'],
    ['000123.40', 'USD', '12340'],
    ['1000', 'JPY', '1000'],
    ['1000.00', 'JPY', '1000'],
    ['1.234', 'KWD', '1234'],
    ['1.2', 'BHD', '1200'],
    ['10.000', 'USD', '1000'],
    // A value well past Number.MAX_SAFE_INTEGER stays exact (no floating point).
    ['123456789012345678.99', 'USD', '12345678901234567899'],
  ])('%s %s -> %s', (value, currency, expected) => {
    expect(parseDecimalToMinorUnits(value, currency)).toBe(expected);
  });

  it.each([
    ['0.01', 'JPY'],
    ['10.001', 'USD'],
    ['-1.00', 'USD'],
    ['1e3', 'USD'],
    ['1,000.00', 'USD'],
    ['', 'USD'],
    [' 1.00', 'USD'],
    ['.5', 'USD'],
    ['5.', 'USD'],
    ['10.00', 'US'],
    ['10.00', 'US1'],
    ['1'.repeat(40), 'USD'],
  ])('rejects %j %j', (value, currency) => {
    expect(parseDecimalToMinorUnits(value, currency)).toBeNull();
  });

  it('rejects non-string input instead of converting through a float', () => {
    expect(parseDecimalToMinorUnits(10.1 as unknown as string, 'USD')).toBeNull();
    expect(parseDecimalToMinorUnits(null as unknown as string, 'USD')).toBeNull();
    expect(parseDecimalToMinorUnits('1.00', 5 as unknown as string)).toBeNull();
  });
});

describe('parseSignedDecimalToMinorUnits', () => {
  it.each([
    ['-10.00', 'USD', '-1000'],
    ['10.00', 'USD', '1000'],
    ['-0.00', 'USD', '0'],
    ['-1000', 'JPY', '-1000'],
  ])('%s %s -> %s', (value, currency, expected) => {
    expect(parseSignedDecimalToMinorUnits(value, currency)).toBe(expected);
  });

  it.each([['--1.00'], ['+1.00'], ['- 1.00'], ['-0.01x'], ['-']])('rejects %j', (value) => {
    expect(parseSignedDecimalToMinorUnits(value, 'USD')).toBeNull();
  });
});
