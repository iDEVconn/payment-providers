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
});
