import {
  CHECKOUT_CREATE_IN_FLIGHT_SAFETY_BUFFER_MS,
  resolveCheckoutCreateEndToEndRequestTimeoutMs,
} from '../../contracts/index';

/**
 * Internal execution budget for checkout create (PayPal sequential HTTP + gateway↔MS round-trip
 * using the same per-request timeout T as {@link resolveCheckoutCreateEndToEndRequestTimeoutMs}).
 * Not a provider-side guarantee.
 */
export const CHECKOUT_CREATE_EXECUTION_LEASE_MS =
  resolveCheckoutCreateEndToEndRequestTimeoutMs(undefined) +
  CHECKOUT_CREATE_IN_FLIGHT_SAFETY_BUFFER_MS +
  resolveCheckoutCreateEndToEndRequestTimeoutMs(undefined);

export function checkoutCreateExecutionLeaseExpiresAt(fromMs: number = Date.now()): string {
  return new Date(fromMs + CHECKOUT_CREATE_EXECUTION_LEASE_MS).toISOString();
}
