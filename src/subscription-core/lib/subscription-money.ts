/*
 * ISO 4217 minor-unit exponents that differ from the default of 2. PayPal
 * sends amounts as decimal strings; they are converted to integer minor units
 * with string arithmetic only, never through a float.
 */
const CURRENCY_EXPONENTS: Readonly<Record<string, number>> = {
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
};

const DEFAULT_EXPONENT = 2;
const MAX_DECIMAL_LENGTH = 32;
const DECIMAL_PATTERN = /^(\d+)(?:\.(\d+))?$/;

/** Uppercase 3-letter currency code, or null. */
export function normalizeCurrencyCode(currency: unknown): string | null {
  if (typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency)) {
    return null;
  }
  return currency.toUpperCase();
}

export function currencyMinorUnitExponent(currency: string): number {
  const code = normalizeCurrencyCode(currency);
  if (!code || !Object.prototype.hasOwnProperty.call(CURRENCY_EXPONENTS, code)) {
    return DEFAULT_EXPONENT;
  }
  return CURRENCY_EXPONENTS[code] ?? DEFAULT_EXPONENT;
}

/**
 * Convert a non-negative decimal string ("10", "10.00", "1.234") to integer
 * minor units. Returns null for anything else: numbers, signs, exponents,
 * separators, surrounding spaces, or fraction digits the currency cannot hold
 * ("0.01" JPY). Trailing zero digits past the exponent are accepted.
 */
export function parseDecimalToMinorUnits(value: string, currency: string): string | null {
  const code = normalizeCurrencyCode(currency);
  if (!code || typeof value !== 'string' || value.length > MAX_DECIMAL_LENGTH) {
    return null;
  }
  const match = DECIMAL_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  const exponent = currencyMinorUnitExponent(code);
  const kept = fraction.slice(0, exponent);
  const dropped = fraction.slice(exponent);
  if (/[^0]/.test(dropped)) {
    return null;
  }
  const digits = `${whole}${kept.padEnd(exponent, '0')}`;
  return digits.replace(/^0+(?=\d)/, '');
}

/**
 * Like `parseDecimalToMinorUnits`, but accepts one leading `-` (refund and
 * reversal totals) and keeps the sign. "-0.00" is "0".
 */
export function parseSignedDecimalToMinorUnits(value: string, currency: string): string | null {
  if (typeof value !== 'string' || !value.startsWith('-')) {
    return parseDecimalToMinorUnits(value, currency);
  }
  const magnitude = parseDecimalToMinorUnits(value.slice(1), currency);
  if (magnitude === null) {
    return null;
  }
  return magnitude === '0' ? '0' : `-${magnitude}`;
}

export function isMinorUnitString(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,30}$/.test(value);
}

/** Compare two minor-unit strings without converting to a float. */
export function compareMinorUnits(left: string, right: string): -1 | 0 | 1 {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}
