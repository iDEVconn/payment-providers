import {
  PAYMENT_RELIABILITY_ERROR,
  PaymentReliabilityError,
  type SubscriptionCreateOptions,
} from '../../contracts/index';

const SHIPPING_PREFERENCES = ['GET_FROM_FILE', 'NO_SHIPPING', 'SET_PROVIDED_ADDRESS'] as const;
const USER_ACTIONS = ['CONTINUE', 'SUBSCRIBE_NOW'] as const;
const PRODUCT_TYPES = ['PHYSICAL', 'DIGITAL', 'SERVICE'] as const;
const MAX_PAYPAL_TEXT_LENGTH = 127;

function invalid(message: string): never {
  throw new PaymentReliabilityError(PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST, message);
}

function optionalText(value: string | null | undefined, label: string): string | undefined {
  if (value == null) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    invalid(`${label} must not be empty`);
  }
  if (trimmed.length > MAX_PAYPAL_TEXT_LENGTH) {
    invalid(`${label} must be at most ${MAX_PAYPAL_TEXT_LENGTH} characters`);
  }
  return trimmed;
}

function optionalMember<T extends string>(
  value: T | null | undefined,
  allowed: readonly T[],
  label: string,
): T | undefined {
  if (value == null) {
    return undefined;
  }
  if (!allowed.includes(value)) {
    invalid(`${label} is not supported`);
  }
  return value;
}

/** Validated optional create-subscription fields; absent fields stay `undefined`. */
export function resolveSubscriptionCreateOptions(
  input: SubscriptionCreateOptions,
): SubscriptionCreateOptions {
  return {
    customId: optionalText(input.customId, 'customId'),
    shippingPreference: optionalMember(
      input.shippingPreference,
      SHIPPING_PREFERENCES,
      'shippingPreference',
    ),
    brandName: optionalText(input.brandName, 'brandName'),
    userAction: optionalMember(input.userAction, USER_ACTIONS, 'userAction'),
    productType: optionalMember(input.productType, PRODUCT_TYPES, 'productType'),
  };
}

/**
 * Fields that join the subscription-create command fingerprint. Only set fields appear, so a
 * request that uses none of the optional fields keeps the fingerprint it had before they existed.
 * Add new create-time fields here (the subscriber email joins the same way).
 */
export function subscriptionCreateFingerprintFields(
  input: SubscriptionCreateOptions,
): Record<string, string> {
  const options = resolveSubscriptionCreateOptions(input);
  return Object.fromEntries(
    Object.entries(options).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
