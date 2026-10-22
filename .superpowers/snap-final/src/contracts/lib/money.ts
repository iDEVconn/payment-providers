/** Canonical provider-neutral money: integer minor units as a decimal string. */
export type CanonicalMoney = {
  currency: string;
  amountMinor: string;
};

export type MoneyValidationError = {
  code: 'INVALID_MONEY';
  message: string;
  path: string;
};
