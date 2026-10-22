import {
  PAYMENT_RELIABILITY_ERROR,
  PaymentReliabilityError,
  type CanonicalMoney,
} from '../../contracts/index';
import { currencyMinorUnitExponent } from '../../subscription-core/lib/subscription-money';

const UNSAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

/** ISO 4217 minor-unit digits; one table, shared with the pure subscription core. */
export function currencyFractionDigits(currency: string): number {
  return currencyMinorUnitExponent(currency.trim());
}

export type ValidateCanonicalMoneyOptions = {
  /** Accept a zero amount (free trial cycles); negative amounts are still rejected. */
  allowZero?: boolean;
};

export function validateCanonicalMoney(
  input: CanonicalMoney,
  options: ValidateCanonicalMoneyOptions = {},
): CanonicalMoney {
  const currency = input.currency?.trim().toUpperCase();
  if (!currency || !/^[A-Z]{3}$/.test(currency)) {
    throw new PaymentReliabilityError(
      PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
      'Currency must be a 3-letter ISO code',
    );
  }

  const amountMinor = input.amountMinor?.trim() ?? '';
  if (!/^-?\d+$/.test(amountMinor)) {
    throw new PaymentReliabilityError(
      PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
      'amountMinor must be a decimal integer string',
    );
  }
  if (amountMinor.includes('e') || amountMinor.includes('E')) {
    throw new PaymentReliabilityError(
      PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
      'amountMinor must not use scientific notation',
    );
  }

  const value = BigInt(amountMinor);
  if (value < 0n) {
    throw new PaymentReliabilityError(
      PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
      'amountMinor must not be negative',
    );
  }
  if (value > UNSAFE_INTEGER) {
    throw new PaymentReliabilityError(
      PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
      'amountMinor exceeds safe integer range',
    );
  }
  if (value === 0n && !options.allowZero) {
    throw new PaymentReliabilityError(
      PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
      'amountMinor must be greater than zero',
    );
  }

  return { currency, amountMinor };
}

export function validateOptionalRefundAmount(
  amount: CanonicalMoney | null | undefined,
): CanonicalMoney | null {
  if (!amount) {
    return null;
  }
  return validateCanonicalMoney(amount);
}

/** Convert canonical minor units to legacy major-unit decimal string for PayPal / @idevconn/payment. */
export function minorUnitsToMajorString(amountMinor: string, currency: string): string {
  const validated = validateCanonicalMoney({ currency, amountMinor });
  const decimalPlaces = currencyFractionDigits(validated.currency);
  if (decimalPlaces === 0) {
    return validated.amountMinor;
  }
  const padded = validated.amountMinor.padStart(decimalPlaces + 1, '0');
  const whole = padded.slice(0, -decimalPlaces);
  const fraction = padded.slice(-decimalPlaces);
  return `${whole}.${fraction}`;
}

/** Map canonical money to legacy CreateOrderInput.amount without changing legacy DTO shape. */
export function canonicalMoneyToLegacyMajorAmount(
  money: CanonicalMoney,
  options: ValidateCanonicalMoneyOptions = {},
): string {
  if (options.allowZero) {
    const validated = validateCanonicalMoney(money, options);
    if (BigInt(validated.amountMinor) === 0n) {
      return '0';
    }
  }
  return minorUnitsToMajorString(money.amountMinor, money.currency);
}

export function toCanonicalMoney(amountMinor: string, currency: string): CanonicalMoney {
  return validateCanonicalMoney({ amountMinor, currency });
}

/** Convert PayPal major-unit decimal strings to integer minor units without floating-point math. */
export function majorUnitsToMinorString(value: string, currency: string): string {
  const normalized = currency.trim().toUpperCase();
  const digits = currencyFractionDigits(normalized);
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new PaymentReliabilityError(
      PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
      'Major-unit amount must be a decimal string',
    );
  }
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const padded = fraction.padEnd(digits, '0').slice(0, digits);
  const minor = `${whole}${padded}`.replace(/^0+(?=\d)/, '') || '0';
  return negative ? `-${minor}` : minor;
}
