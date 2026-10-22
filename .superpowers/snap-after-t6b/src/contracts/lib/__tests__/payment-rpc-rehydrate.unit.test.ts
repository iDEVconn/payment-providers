import { describe, expect, it } from 'vitest';
import {
  PaymentCapabilityError,
  rehydratePaymentRpcError,
  toPaymentReliabilityErrorPayload,
} from '../errors';
import { PaymentReliabilityError, PAYMENT_RELIABILITY_ERROR } from '../reliability-errors';

describe('rehydratePaymentRpcError', () => {
  it('rehydrates capability and reliability RPC payloads', () => {
    const capability = rehydratePaymentRpcError({
      code: 'CAPABILITY_UNAVAILABLE',
      capability: 'checkout',
      unavailableReason: 'missing secret',
      message: 'unavailable',
    });
    expect(capability).toBeInstanceOf(PaymentCapabilityError);

    const reliability = rehydratePaymentRpcError({
      name: 'PaymentReliabilityError',
      code: PAYMENT_RELIABILITY_ERROR.PROVIDER_AUTH_FAILURE,
      message: 'auth failed',
    });
    expect(reliability).toBeInstanceOf(PaymentReliabilityError);
    expect((reliability as PaymentReliabilityError).code).toBe(
      PAYMENT_RELIABILITY_ERROR.PROVIDER_AUTH_FAILURE,
    );
  });

  it('round-trips subscription-create failure metadata on PaymentReliabilityError', () => {
    const original = new PaymentReliabilityError(
      PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
      'PayPal subscription response did not include a provider id',
      {
        operationId: '11111111-1111-4111-8111-111111111111',
        paymentOutcome: 'unknown',
      },
    );
    const payload = toPaymentReliabilityErrorPayload(original);
    const rehydrated = rehydratePaymentRpcError(payload);
    expect(rehydrated).toBeInstanceOf(PaymentReliabilityError);
    expect(rehydrated).toMatchObject({
      code: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
      message: 'PayPal subscription response did not include a provider id',
      operationId: '11111111-1111-4111-8111-111111111111',
      paymentOutcome: 'unknown',
    });
  });
});
