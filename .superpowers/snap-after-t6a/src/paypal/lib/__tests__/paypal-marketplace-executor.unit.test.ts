import { describe, expect, it, vi } from 'vitest';
import { PAYMENT_RELIABILITY_ERROR } from '../../../contracts/index';
import { evaluateCapabilities, type ResolvedPaymentRuntime } from '../../../core/index';
import { sandboxPaypalProviderConfig } from '../../../../test/helpers/provider-config-fixtures';
import { PaypalMarketplaceExecutor } from '../paypal-marketplace-executor';
import type { PaypalOrdersHttpClient } from '../paypal-orders-http-client';

const ctx = {
  providerCode: 'paypal',
  accountRef: 'default',
  applicationRef: 'test-app',
  environment: 'sandbox' as const,
  providerRequestId: 'req-1',
};

function runtime(): ResolvedPaymentRuntime {
  return {
    mode: 'live-provider',
    context: ctx,
    descriptor: {
      ...ctx,
      capabilities: evaluateCapabilities(
        sandboxPaypalProviderConfig({
          credentials: { clientId: 'set', clientSecret: 'set' },
          capabilityFlags: { marketplace_checkout: true },
          partner: {
            merchantId: 'partner-merchant',
            attributionId: 'BN-TEST',
          },
        }),
        ctx,
      ),
    },
    checkoutCredentials: {
      clientId: 'id',
      clientSecret: 'secret',
      environment: 'sandbox',
    },
  };
}

function executor(httpClient: PaypalOrdersHttpClient): PaypalMarketplaceExecutor {
  return new PaypalMarketplaceExecutor(runtime(), httpClient, async () => 'token', {
    partnerAttributionId: 'BN-TEST',
  });
}

describe('PaypalMarketplaceExecutor capture outcomes', () => {
  it('parses 207 partial capture responses', async () => {
    const httpClient: PaypalOrdersHttpClient = {
      request: vi.fn().mockResolvedValue({
        status: 207,
        debugId: 'dbg-207',
        body: {
          id: 'ORDER-1',
          status: 'PARTIALLY_COMPLETED',
          purchase_units: [
            {
              reference_id: 'unit-a',
              payments: {
                captures: [
                  {
                    id: 'CAP-A',
                    status: 'COMPLETED',
                    amount: { currency_code: 'USD', value: '10.00' },
                  },
                ],
              },
            },
            {
              reference_id: 'unit-b',
              payments: { captures: [] },
            },
          ],
        },
      }),
    };

    const result = await executor(httpClient).captureOrder({
      ...ctx,
      providerOrderId: 'ORDER-1',
    });

    expect(result.httpStatus).toBe(207);
    expect(result.marketplaceStatus).toBe('partially_captured');
    expect(result.units.some((unit) => unit.unitStatus === 'captured')).toBe(true);
  });

  it('throws terminal rejection for pre-capture 422 issues', async () => {
    const httpClient: PaypalOrdersHttpClient = {
      request: vi.fn().mockResolvedValue({
        status: 422,
        debugId: 'dbg-422-terminal',
        body: { details: [{ issue: 'ORDER_NOT_APPROVED' }] },
      }),
    };

    await expect(
      executor(httpClient).captureOrder({ ...ctx, providerOrderId: 'ORDER-1' }),
    ).rejects.toMatchObject({
      code: PAYMENT_RELIABILITY_ERROR.PROVIDER_TERMINAL_REJECTION,
      uncertain: false,
    });
  });

  it('throws uncertain for ambiguous 422 issues', async () => {
    const httpClient: PaypalOrdersHttpClient = {
      request: vi.fn().mockResolvedValue({
        status: 422,
        debugId: 'dbg-422-uncertain',
        body: { details: [{ issue: 'INSTRUMENT_DECLINED' }] },
      }),
    };

    await expect(
      executor(httpClient).captureOrder({ ...ctx, providerOrderId: 'ORDER-1' }),
    ).rejects.toMatchObject({
      code: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
      uncertain: true,
    });
  });

  it('throws uncertain for capture 504 timeouts', async () => {
    const httpClient: PaypalOrdersHttpClient = {
      request: vi.fn().mockResolvedValue({
        status: 504,
        debugId: 'dbg-504',
        body: {},
      }),
    };

    await expect(
      executor(httpClient).captureOrder({ ...ctx, providerOrderId: 'ORDER-1' }),
    ).rejects.toMatchObject({
      code: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
      uncertain: true,
    });
  });

  it('refunds a capture without EDC fee fields', async () => {
    const httpClient: PaypalOrdersHttpClient = {
      request: vi.fn().mockResolvedValue({
        status: 201,
        debugId: 'dbg-refund',
        body: {
          id: 'REFUND-1',
          status: 'COMPLETED',
          amount: { currency_code: 'USD', value: '5.00' },
        },
      }),
    };

    const result = await executor(httpClient).refundUnit({
      ...ctx,
      providerCaptureId: 'CAP-1',
      amount: { currency: 'USD', amountMinor: '500' },
    });

    expect(result.providerRefundId).toBe('REFUND-1');
    expect(result.refundStatus).toBe('completed');
    const requestBody = (httpClient.request as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.body;
    expect(JSON.stringify(requestBody ?? {})).not.toContain('edc');
  });
});
