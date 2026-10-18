import { describe, expect, it, vi } from 'vitest';
import {
  PAYMENT_RELIABILITY_ERROR,
  type ExecuteCreateBillingPlanRequest,
} from '../../../contracts/index';
import { evaluateCapabilities, type ResolvedPaymentRuntime } from '../../../core/index';
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
    applicationRef: 'edc',
    environment: 'sandbox' as const,
  };
  return {
    mode: 'live-provider',
    context,
    descriptor: {
      ...context,
      capabilities: evaluateCapabilities((key) => {
        if (key === 'PAYPAL_CLIENT_ID' || key === 'PAYPAL_CLIENT_SECRET') return 'set';
        if (key === 'PAYPAL_SUBSCRIPTIONS_ENABLED') return enabled ? 'true' : undefined;
        return undefined;
      }, context),
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
      applicationRef: 'edc',
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
      applicationRef: 'edc',
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
        applicationRef: 'edc',
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
        applicationRef: 'edc',
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
      applicationRef: 'edc',
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
});
