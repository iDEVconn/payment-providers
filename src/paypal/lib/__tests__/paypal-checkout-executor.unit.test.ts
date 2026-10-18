import { describe, expect, it, vi } from 'vitest';
import type { ResolvedPaymentRuntime } from '../../../core/index';
import type { PaypalOrdersHttpRequest } from '../paypal-orders-http-client';
import { PaypalCheckoutExecutor } from '../paypal-checkout-executor';

function runtime(): ResolvedPaymentRuntime {
  return {
    mode: 'live-provider',
    context: {
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'edc',
      environment: 'sandbox',
    },
    descriptor: {
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'edc',
      environment: 'sandbox',
      capabilities: [
        {
          capability: 'checkout',
          implemented: true,
          enabled: true,
          configured: true,
          eligible: true,
          ready: true,
        },
      ],
    },
  };
}

describe('PaypalCheckoutExecutor', () => {
  it('creates an Orders v2 checkout with experience_context return and cancel URLs', async () => {
    const requests: PaypalOrdersHttpRequest[] = [];
    const strategy = { createOrder: vi.fn() };
    const strategyFactory = vi.fn(() => strategy as never);
    const executor = new PaypalCheckoutExecutor(
      runtime(),
      strategyFactory,
      {
        request: async (input) => {
          requests.push(input);
          return {
            status: 201,
            debugId: 'debug-1',
            body: {
              id: 'ORDER-1',
              status: 'CREATED',
              links: [
                {
                  rel: 'payer-action',
                  href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1',
                },
              ],
            },
          };
        },
      },
      async () => 'token',
    );

    const created = await executor.createOrder({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'edc',
      environment: 'sandbox',
      providerRequestId: 'advertiser-funding-create:fund-1',
      amount: { currency: 'USD', amountMinor: '10700' },
      referenceId: 'fund-1',
      returnUrl: 'http://localhost:4200/wallet?fundingAction=return',
      cancelUrl: 'http://localhost:4200/wallet?fundingAction=cancel',
    });

    expect(strategy.createOrder).not.toHaveBeenCalled();
    expect(created.providerOrderId).toBe('ORDER-1');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe('https://api-m.sandbox.paypal.com/v2/checkout/orders');
    expect(requests[0]?.requestId).toBe('advertiser-funding-create:fund-1');
    expect(requests[0]?.body).toMatchObject({
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: 'fund-1',
          amount: { currency_code: 'USD', value: '107.00' },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            user_action: 'PAY_NOW',
            return_url: 'http://localhost:4200/wallet?fundingAction=return',
            cancel_url: 'http://localhost:4200/wallet?fundingAction=cancel',
          },
        },
      },
    });
    expect(JSON.stringify(requests[0]?.body)).not.toContain('application_context');
    expect(created.approvalUrl).toBe('https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1');
  });

  it('does not send Prefer return=representation on order GET', async () => {
    const requests: PaypalOrdersHttpRequest[] = [];
    const executor = new PaypalCheckoutExecutor(
      runtime(),
      vi.fn(() => ({ createOrder: vi.fn() }) as never),
      {
        request: async (input) => {
          requests.push(input);
          return {
            status: 200,
            debugId: 'debug-get',
            body: {
              id: 'ORDER-GET',
              status: 'APPROVED',
              purchase_units: [
                {
                  amount: { currency_code: 'USD', value: '107.00' },
                  payments: { captures: [] },
                },
              ],
              links: [],
            },
          };
        },
      },
      async () => 'token',
    );

    await executor.getOrder({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'edc',
      environment: 'sandbox',
      providerOrderId: 'ORDER-GET',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.preferRepresentation).toBeUndefined();
  });

  it('returns capture amount separately from purchase-unit amount on GET', async () => {
    const executor = new PaypalCheckoutExecutor(
      runtime(),
      vi.fn(() => ({ createOrder: vi.fn() }) as never),
      {
        request: async () => ({
          status: 200,
          debugId: 'debug-get-capture-amount',
          body: {
            id: 'ORDER-CAPTURE-AMOUNT',
            status: 'COMPLETED',
            purchase_units: [
              {
                amount: { currency_code: 'USD', value: '200.00' },
                payments: {
                  captures: [
                    {
                      id: 'CAP-107',
                      status: 'COMPLETED',
                      amount: { currency_code: 'USD', value: '107.00' },
                    },
                  ],
                },
              },
            ],
            links: [],
          },
        }),
      },
      async () => 'token',
    );

    const order = await executor.getOrder({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'edc',
      environment: 'sandbox',
      providerOrderId: 'ORDER-CAPTURE-AMOUNT',
    });

    expect(order.amount).toEqual({ currency: 'USD', amountMinor: '20000' });
    expect(order.captureAmount).toEqual({ currency: 'USD', amountMinor: '10700' });
    expect(order.providerCaptureId).toBe('CAP-107');
  });
});
