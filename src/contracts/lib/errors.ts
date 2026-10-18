import type { PaymentCapability } from './capabilities';

export const PAYMENT_CAPABILITY_UNAVAILABLE = 'CAPABILITY_UNAVAILABLE' as const;

export class PaymentCapabilityError extends Error {
  readonly code = PAYMENT_CAPABILITY_UNAVAILABLE;
  readonly capability: PaymentCapability;
  readonly unavailableReason: string;

  constructor(capability: PaymentCapability, unavailableReason: string) {
    super(`Payment capability "${capability}" is unavailable: ${unavailableReason}`);
    this.name = 'PaymentCapabilityError';
    this.capability = capability;
    this.unavailableReason = unavailableReason;
  }
}

/** JSON-safe TCP payload. Never serialize this error as `[object Object]`. */
export type PaymentCapabilityErrorPayload = {
  code: typeof PAYMENT_CAPABILITY_UNAVAILABLE;
  capability: PaymentCapability;
  unavailableReason: string;
  message: string;
};

export function toPaymentCapabilityErrorPayload(
  error: PaymentCapabilityError,
): PaymentCapabilityErrorPayload {
  return {
    code: PAYMENT_CAPABILITY_UNAVAILABLE,
    capability: error.capability,
    unavailableReason: error.unavailableReason,
    message: error.message,
  };
}

export function isPaymentCapabilityErrorPayload(
  value: unknown,
): value is PaymentCapabilityErrorPayload {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    row['code'] === PAYMENT_CAPABILITY_UNAVAILABLE &&
    typeof row['capability'] === 'string' &&
    typeof row['unavailableReason'] === 'string' &&
    typeof row['message'] === 'string'
  );
}

function payloadFromUnknown(value: unknown): PaymentCapabilityErrorPayload | null {
  if (isPaymentCapabilityErrorPayload(value)) {
    return value;
  }
  if (!value || typeof value !== 'object') {
    return null;
  }
  const row = value as Record<string, unknown>;
  if (typeof row['getError'] === 'function') {
    return payloadFromUnknown(row['getError']());
  }
  return payloadFromUnknown(row['message']) ?? payloadFromUnknown(row['error']);
}

export function rehydratePaymentCapabilityError(value: unknown): PaymentCapabilityError | null {
  if (value instanceof PaymentCapabilityError) {
    return value;
  }
  const payload = payloadFromUnknown(value);
  if (!payload) {
    return null;
  }
  return new PaymentCapabilityError(payload.capability, payload.unavailableReason);
}

export function rehydratePaymentRpcError(value: unknown): unknown {
  return rehydratePaymentCapabilityError(value) ?? value;
}
