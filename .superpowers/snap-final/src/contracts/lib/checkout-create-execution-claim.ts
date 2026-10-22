/**
 * In-flight checkout create claims (submitted without provider ids) use the same per-request
 * timeout as PayPal HTTP clients when PAYPAL_REQUEST_TIMEOUT_MS is unset
 * (see paypal-checkout-executor.factory.ts → 10_000 ms).
 */
export const CHECKOUT_CREATE_DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** OAuth token fetch + checkout orders POST in createOrderWithExperienceContext. */
export const CHECKOUT_CREATE_END_TO_END_HTTP_STEPS = 2;

/** Margin after sequential HTTP timeouts before treating a submitted claim as abandoned. */
export const CHECKOUT_CREATE_IN_FLIGHT_SAFETY_BUFFER_MS = 2_000;

export type CheckoutProviderCreateExecutionClaimState = 'in_flight' | 'reclaimable' | 'unavailable';

export function resolveCheckoutCreateEndToEndRequestTimeoutMs(
  configuredRequestTimeoutMs?: number,
): number {
  const perRequestMs = configuredRequestTimeoutMs ?? CHECKOUT_CREATE_DEFAULT_REQUEST_TIMEOUT_MS;
  return perRequestMs * CHECKOUT_CREATE_END_TO_END_HTTP_STEPS;
}

export function evaluateCheckoutCreateExecutionClaimState(
  latestExecutionClaimAt: string | null,
  configuredRequestTimeoutMs: number | undefined,
  nowMs: number = Date.now(),
): CheckoutProviderCreateExecutionClaimState {
  if (!latestExecutionClaimAt) {
    return 'unavailable';
  }
  const claimMs = Date.parse(latestExecutionClaimAt);
  if (Number.isNaN(claimMs)) {
    return 'unavailable';
  }
  const inFlightUntilMs =
    claimMs +
    resolveCheckoutCreateEndToEndRequestTimeoutMs(configuredRequestTimeoutMs) +
    CHECKOUT_CREATE_IN_FLIGHT_SAFETY_BUFFER_MS;
  if (nowMs < inFlightUntilMs) {
    return 'in_flight';
  }
  return 'reclaimable';
}
