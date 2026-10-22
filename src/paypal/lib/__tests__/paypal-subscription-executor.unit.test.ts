import { describe, expect, it, vi } from 'vitest';
import {
  PAYMENT_RELIABILITY_ERROR,
  type ExecuteCreateBillingPlanRequest,
} from '../../../contracts/index';
import { evaluateCapabilities, type ResolvedPaymentRuntime } from '../../../core/index';
import { sandboxPaypalProviderConfig } from '../../../../test/helpers/provider-config-fixtures';
import type {
  PaypalSubscriptionHttpClient,
  PaypalSubscriptionHttpResponse,
} from '../paypal-subscription-http-client';
import { FakePaypalSubscriptionHttpClient } from '../fake-paypal-subscription-http-client';
import { PaypalSubscriptionExecutor } from '../paypal-subscription-executor';

function runtime(enabled: boolean): ResolvedPaymentRuntime {
  const context = {
    providerCode: 'paypal',
    accountRef: 'default',
    applicationRef: 'test-app',
    environment: 'sandbox' as const,
  };
  return {
    mode: 'live-provider',
    context,
    descriptor: {
      ...context,
      capabilities: evaluateCapabilities(
        sandboxPaypalProviderConfig({
          credentials: { clientId: 'set', clientSecret: 'set' },
          capabilityFlags: { subscription: enabled },
        }),
        context,
      ),
    },
    checkoutCredentials: {
      clientId: 'id',
      clientSecret: 'secret',
      environment: 'sandbox',
    },
  };
}

describe('PaypalSubscriptionExecutor', () => {
  it('creates a subscription with approval URL', async () => {
    const executor = new PaypalSubscriptionExecutor(
      runtime(true),
      new FakePaypalSubscriptionHttpClient(),
      async () => 'token',
    );
    const result = await executor.createSubscription({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      providerRequestId: 'req-1',
      providerPlanId: 'FAKE-PLAN-1',
      subscriberEmail: 'subscriber@example.com',
    });

    expect(result.subscriptionStatus).toBe('approval_pending');
    expect(result.approvalUrl).toBe('https://example.test/approve');
    expect(result.providerSubscriptionId).toBe('FAKE-SUB-1');
  });

  it('creates catalog products with created status', async () => {
    const executor = new PaypalSubscriptionExecutor(
      runtime(true),
      new FakePaypalSubscriptionHttpClient(),
      async () => 'token',
    );
    const result = await executor.createProduct({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      providerRequestId: 'req-2',
      name: 'Premium',
      type: 'SERVICE',
    });
    expect(result.productStatus).toBe('created');
    expect(result.providerProductId).toBe('FAKE-PROD-1');
  });

  it('rejects catalog product responses without a provider id', async () => {
    const httpClient: PaypalSubscriptionHttpClient = {
      request: vi.fn(
        async (): Promise<PaypalSubscriptionHttpResponse> => ({
          status: 201,
          body: { name: 'Premium' },
          debugId: 'missing-id',
        }),
      ),
    };
    const executor = new PaypalSubscriptionExecutor(runtime(true), httpClient, async () => 'token');
    await expect(
      executor.createProduct({
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'test-app',
        environment: 'sandbox',
        providerRequestId: 'req-missing-product',
        name: 'Premium',
        type: 'SERVICE',
      }),
    ).rejects.toMatchObject({
      code: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
      message: 'PayPal catalog product response did not include a provider id',
    });
  });

  it('rejects subscription responses without a provider id', async () => {
    const httpClient: PaypalSubscriptionHttpClient = {
      request: vi.fn(
        async (): Promise<PaypalSubscriptionHttpResponse> => ({
          status: 201,
          body: { status: 'APPROVAL_PENDING' },
          debugId: 'missing-sub-id',
        }),
      ),
    };
    const executor = new PaypalSubscriptionExecutor(runtime(true), httpClient, async () => 'token');
    await expect(
      executor.createSubscription({
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'test-app',
        environment: 'sandbox',
        providerRequestId: 'req-missing-sub',
        providerPlanId: 'PLAN-1',
        subscriberEmail: null,
      }),
    ).rejects.toMatchObject({
      code: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
      message: 'PayPal subscription response did not include a provider id',
      uncertain: true,
      retryable: true,
    });
  });

  it('rejects billing plan responses without a provider id', async () => {
    const httpClient: PaypalSubscriptionHttpClient = {
      request: vi.fn(
        async (): Promise<PaypalSubscriptionHttpResponse> => ({
          status: 201,
          body: { status: 'CREATED' },
          debugId: 'missing-id',
        }),
      ),
    };
    const executor = new PaypalSubscriptionExecutor(runtime(true), httpClient, async () => 'token');
    await expect(
      executor.createPlan({
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'test-app',
        environment: 'sandbox',
        providerRequestId: 'req-missing-plan',
        providerProductId: 'PROD-1',
        name: 'Individual',
        status: 'CREATED',
        billingCycles: [
          {
            tenureType: 'REGULAR',
            sequence: 1,
            totalCycles: 0,
            intervalUnit: 'MONTH',
            intervalCount: 1,
            price: { currency: 'USD', amountMinor: '700' },
          },
        ],
        paymentPreferences: { autoBillOutstanding: true },
      }),
    ).rejects.toMatchObject({
      code: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
      message: 'PayPal billing plan response did not include a provider id',
    });
  });

  it('maps catalog plan payload to PayPal billing_cycles with unlimited regular cycle', async () => {
    const captured: { body?: Record<string, unknown> } = {};
    const httpClient: PaypalSubscriptionHttpClient = {
      request: vi.fn(async (input) => {
        captured.body = input.body as Record<string, unknown>;
        return {
          status: 201,
          body: { id: 'FAKE-PLAN-2', status: 'CREATED' },
          debugId: 'fake-debug',
        };
      }),
    };
    const executor = new PaypalSubscriptionExecutor(runtime(true), httpClient, async () => 'token');
    const context = {
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox' as const,
    };
    function monthlyPlanFixture(input: {
      name: string;
      description: string;
      amountMinor: string;
    }): ExecuteCreateBillingPlanRequest {
      return {
        ...context,
        providerRequestId: 'fixture-request',
        providerProductId: 'PROD-1',
        name: input.name,
        description: input.description,
        status: 'CREATED',
        billingCycles: [
          {
            tenureType: 'REGULAR',
            intervalUnit: 'MONTH',
            intervalCount: 1,
            sequence: 1,
            totalCycles: 0,
            price: { currency: 'USD', amountMinor: input.amountMinor },
          },
        ],
        paymentPreferences: { autoBillOutstanding: true },
      };
    }
    const individual = monthlyPlanFixture({
      name: 'Individual Creator',
      description: 'Individual',
      amountMinor: '700',
    });
    const company = monthlyPlanFixture({
      name: 'Company Creator',
      description: 'Company',
      amountMinor: '1500',
    });

    await executor.createPlan({
      ...individual,
      providerRequestId: 'req-individual',
    });
    const individualCycles = captured.body?.['billing_cycles'] as Array<Record<string, unknown>>;
    expect(individualCycles[0]?.['total_cycles']).toBe(0);
    expect(
      (individualCycles[0]?.['pricing_scheme'] as Record<string, unknown>)?.['fixed_price'],
    ).toEqual({ currency_code: 'USD', value: '7.00' });

    await executor.createPlan({
      ...company,
      providerRequestId: 'req-company',
    });
    const companyCycles = captured.body?.['billing_cycles'] as Array<Record<string, unknown>>;
    expect(
      (companyCycles[0]?.['pricing_scheme'] as Record<string, unknown>)?.['fixed_price'],
    ).toEqual({ currency_code: 'USD', value: '15.00' });
  });

  const lifecycleContext = {
    providerCode: 'paypal' as const,
    accountRef: 'default',
    applicationRef: 'test-app',
    environment: 'sandbox' as const,
    providerSubscriptionId: 'FAKE-SUB-1',
    reason: 'Lifecycle test',
  };

  it('refreshes subscription state via GET after lifecycle POST 204', async () => {
    const executor = new PaypalSubscriptionExecutor(
      runtime(true),
      new FakePaypalSubscriptionHttpClient(),
      async () => 'token',
    );
    await executor.createSubscription({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      providerRequestId: 'req-sub-life',
      providerPlanId: 'FAKE-PLAN-1',
    });

    const cancelled = await executor.cancelSubscription(lifecycleContext);
    expect(cancelled.subscriptionStateRefreshPending).not.toBe(true);
    expect(cancelled.subscriptionStatus).toBe('cancelled');
    expect(cancelled.providerSubscriptionStateAt).toBe('2026-10-20T12:00:00.000Z');
  });

  it('returns refresh pending when lifecycle POST succeeds but GET fails', async () => {
    let callCount = 0;
    const httpClient: PaypalSubscriptionHttpClient = {
      request: vi.fn(async (input) => {
        if (input.method === 'POST' && input.path.includes('/cancel')) {
          return { status: 204, body: {}, debugId: 'post-204' };
        }
        callCount += 1;
        return { status: 503, body: {}, debugId: 'get-fail' };
      }),
    };
    const executor = new PaypalSubscriptionExecutor(runtime(true), httpClient, async () => 'token');
    const result = await executor.cancelSubscription(lifecycleContext);
    expect(result.subscriptionStateRefreshPending).toBe(true);
    expect(result.subscriptionStateRefreshErrorCode).toBe(
      PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
    );
    expect(callCount).toBe(1);
  });

  it('rejects lifecycle POST failures without treating them as refresh pending', async () => {
    const httpClient: PaypalSubscriptionHttpClient = {
      request: vi.fn(async () => ({
        status: 422,
        body: {},
        debugId: 'post-reject',
      })),
    };
    const executor = new PaypalSubscriptionExecutor(runtime(true), httpClient, async () => 'token');
    await expect(executor.cancelSubscription(lifecycleContext)).rejects.toMatchObject({
      code: PAYMENT_RELIABILITY_ERROR.PROVIDER_TERMINAL_REJECTION,
    });
  });

  it('surfaces uncertain outcome when lifecycle POST times out', async () => {
    const httpClient: PaypalSubscriptionHttpClient = {
      request: vi.fn(async () => {
        throw {
          code: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
          message: 'PayPal subscription cancel failed',
          retryable: true,
          uncertain: true,
        };
      }),
    };
    const executor = new PaypalSubscriptionExecutor(runtime(true), httpClient, async () => 'token');
    await expect(executor.cancelSubscription(lifecycleContext)).rejects.toMatchObject({
      code: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
      uncertain: true,
    });
  });
  describe('createSubscription request body', () => {
    const base = {
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox' as const,
      providerRequestId: 'req-body',
      providerPlanId: 'PLAN-1',
    };

    async function sentBody(extra: Record<string, unknown> = {}) {
      let body: Record<string, unknown> | undefined;
      const httpClient: PaypalSubscriptionHttpClient = {
        request: vi.fn(async (input) => {
          body = input.body;
          return { status: 201, body: { id: 'I-SUB', status: 'APPROVAL_PENDING' } };
        }),
      };
      const executor = new PaypalSubscriptionExecutor(runtime(true), httpClient, async () => 'token');
      await executor.createSubscription({ ...base, ...extra });
      return body as { custom_id?: string; application_context?: Record<string, unknown> };
    }

    it('defaults to NO_SHIPPING and sends no custom_id when nothing is set', async () => {
      const body = await sentBody();
      expect(body.custom_id).toBeUndefined();
      expect(body.application_context).toMatchObject({ shipping_preference: 'NO_SHIPPING' });
    });

    it.each(['DIGITAL', 'SERVICE'] as const)('defaults to NO_SHIPPING for %s products', async (productType) => {
      const body = await sentBody({ productType });
      expect(body.application_context?.['shipping_preference']).toBe('NO_SHIPPING');
    });

    it('leaves the PayPal shipping default for physical products', async () => {
      const body = await sentBody({ productType: 'PHYSICAL' });
      expect(body.application_context?.['shipping_preference']).toBeUndefined();
    });

    it('maps customId, brandName, userAction and return URLs', async () => {
      const body = await sentBody({
        customId: 'user-1:pro',
        brandName: 'Acme',
        userAction: 'SUBSCRIBE_NOW',
        returnUrl: 'https://app.test/ok',
        cancelUrl: 'https://app.test/no',
      });
      expect(body.custom_id).toBe('user-1:pro');
      expect(body.application_context).toEqual({
        brand_name: 'Acme',
        user_action: 'SUBSCRIBE_NOW',
        shipping_preference: 'NO_SHIPPING',
        return_url: 'https://app.test/ok',
        cancel_url: 'https://app.test/no',
      });
    });

    it('lets an explicit shipping preference win over the default', async () => {
      const body = await sentBody({ shippingPreference: 'GET_FROM_FILE', productType: 'DIGITAL' });
      expect(body.application_context?.['shipping_preference']).toBe('GET_FROM_FILE');
    });
  });

  it('sends a free trial with a zero price and rejects a regular cycle without one', async () => {
    let body: { billing_cycles?: Array<Record<string, unknown>> } | undefined;
    const httpClient: PaypalSubscriptionHttpClient = {
      request: vi.fn(async (input) => {
        body = input.body as typeof body;
        return { status: 201, body: { id: 'P-1', status: 'CREATED' } };
      }),
    };
    const executor = new PaypalSubscriptionExecutor(runtime(true), httpClient, async () => 'token');
    await executor.createPlan({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      providerRequestId: 'req-trial',
      providerProductId: 'PROD-1',
      name: 'Trial plan',
      billingCycles: [
        {
          tenureType: 'TRIAL',
          sequence: 1,
          totalCycles: 1,
          intervalUnit: 'WEEK',
          intervalCount: 1,
          price: { currency: 'USD', amountMinor: '0' },
        },
        {
          tenureType: 'REGULAR',
          sequence: 2,
          totalCycles: 0,
          intervalUnit: 'MONTH',
          intervalCount: 1,
          price: { currency: 'USD', amountMinor: '999' },
        },
      ],
      paymentPreferences: {},
    });
    expect(body?.billing_cycles?.[0]?.['pricing_scheme']).toEqual({
      fixed_price: { currency_code: 'USD', value: '0' },
    });
    expect(body?.billing_cycles?.[1]?.['pricing_scheme']).toEqual({
      fixed_price: { currency_code: 'USD', value: '9.99' },
    });
  });

  it('keeps the PayPal debug id when a create response has no provider id', async () => {
    const httpClient: PaypalSubscriptionHttpClient = {
      request: vi.fn(async () => ({
        status: 201,
        body: { status: 'APPROVAL_PENDING' },
        debugId: 'dbg-no-id',
      })),
    };
    const executor = new PaypalSubscriptionExecutor(runtime(true), httpClient, async () => 'token');
    await expect(
      executor.createSubscription({
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'test-app',
        environment: 'sandbox',
        providerRequestId: 'req-no-id',
        providerPlanId: 'PLAN-1',
      }),
    ).rejects.toMatchObject({ providerDebugId: 'dbg-no-id' });
  });

  it('returns last payment, failed payment count and outstanding balance from GET (#4)', async () => {
    const httpClient: PaypalSubscriptionHttpClient = {
      request: vi.fn(async () => ({
        status: 200,
        body: {
          id: 'I-BILLING',
          plan_id: 'P-1',
          status: 'ACTIVE',
          billing_info: {
            next_billing_time: '2026-11-22T10:00:00Z',
            last_payment: {
              amount: { currency_code: 'USD', value: '9.99' },
              time: '2026-10-22T10:00:00Z',
            },
            failed_payments_count: 2,
            outstanding_balance: { currency_code: 'USD', value: '19.98' },
          },
        },
      })),
    };
    const executor = new PaypalSubscriptionExecutor(runtime(true), httpClient, async () => 'token');

    const result = await executor.getSubscription({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      providerSubscriptionId: 'I-BILLING',
    });

    expect(result.lastPayment).toEqual({
      amountMinor: '999',
      currency: 'USD',
      time: '2026-10-22T10:00:00.000Z',
    });
    expect(result.failedPaymentsCount).toBe(2);
    expect(result.outstandingBalance).toEqual({ amountMinor: '1998', currency: 'USD' });
  });
});
