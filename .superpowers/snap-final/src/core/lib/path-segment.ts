import { PAYMENT_RELIABILITY_ERROR, PaymentReliabilityError } from '../../contracts/index';

/**
 * Encodes a provider id for use as ONE URL path segment. `encodeURIComponent` alone leaves `.`
 * and `..` intact and accepts an empty string, so those, whitespace-only ids and ids with
 * control characters are refused instead of being sent.
 */
export function pathSegment(id: string, label: string): string {
  if (typeof id !== 'string' || !id.trim() || id === '.' || id === '..' || /[\u0000-\u001f\u007f]/.test(id)) {
    throw new PaymentReliabilityError(
      PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
      `${label} is not a valid provider resource id`,
    );
  }
  return encodeURIComponent(id);
}
