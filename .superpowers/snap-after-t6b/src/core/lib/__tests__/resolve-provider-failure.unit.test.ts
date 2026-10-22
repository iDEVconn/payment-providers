import { describe, expect, it } from 'vitest';
import {
  PAYMENT_CAPABILITY_UNAVAILABLE,
  PAYMENT_RELIABILITY_ERROR,
  PaymentCapabilityError,
  PaymentReliabilityError,
} from '../../../contracts/index';
import { resolveProviderFailure } from '../resolve-provider-failure';

describe('resolveProviderFailure', () => {
  it('preserves PaymentCapabilityError as terminal pre-provider failure', () => {
    const error = new PaymentCapabilityError('payout', 'Capability is disabled by configuration');
    expect(resolveProviderFailure(error)).toEqual({
      code: PAYMENT_CAPABILITY_UNAVAILABLE,
      message: 'Capability is disabled by configuration',
      uncertain: false,
      retryable: false,
      providerDebugId: null,
    });
  });

  it('rehydrates plain RPC capability payloads without object Object messages', () => {
    expect(
      resolveProviderFailure({
        code: PAYMENT_CAPABILITY_UNAVAILABLE,
        capability: 'payout',
        unavailableReason: 'Capability is disabled by configuration',
        message:
          'Payment capability "payout" is unavailable: Capability is disabled by configuration',
      }),
    ).toMatchObject({
      code: PAYMENT_CAPABILITY_UNAVAILABLE,
      message: 'Capability is disabled by configuration',
      uncertain: false,
      retryable: false,
    });
  });

  it('sanitizes PaymentReliabilityError messages that contain secrets', () => {
    const error = new PaymentReliabilityError(
      PAYMENT_RELIABILITY_ERROR.PROVIDER_RETRYABLE,
      'upstream Authorization: Bearer fake-access-token',
    );
    expect(resolveProviderFailure(error).message).toBe('Payment reliability error');
    expect(JSON.stringify(resolveProviderFailure(error))).not.toContain('fake-access-token');
  });

  it('keeps uncertain transport failures as PROVIDER_UNCERTAIN', () => {
    expect(
      resolveProviderFailure({
        code: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
        message: 'PayPal payout submission returned uncertain outcome',
        uncertain: true,
        retryable: true,
        providerDebugId: 'debug-1',
      }),
    ).toMatchObject({
      code: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
      uncertain: true,
      retryable: true,
      providerDebugId: 'debug-1',
    });
  });
});
