import { describe, expect, it, vi } from 'vitest';
import type { PaymentExecutionStatus } from '../../../contracts/index';
import { PaymentConfigurationError } from '../../../core/lib/payment-configuration-error';
import {
  MemoryPaymentReliabilityStore,
  resolvePaymentRuntime,
  WebhookProcessingService,
  type ResolvedPaymentRuntime,
} from '../../../core/index';
import { buildPaypalCheckoutExecutor } from '../paypal-checkout-executor.factory';
import { buildPaypalMarketplaceExecutor } from '../paypal-marketplace-executor.factory';
import { buildPaypalPayoutExecutor } from '../paypal-payout-executor.factory';
import { buildPaypalSellerOnboardingExecutor } from '../paypal-seller-onboarding-executor.factory';
import { buildPaypalSubscriptionExecutor } from '../paypal-subscription-executor.factory';
import { buildPaypalWebhookVerifier } from '../paypal-webhook-verifier.factory';

const context = {
  providerCode: 'paypal',
  accountRef: 'default',
  applicationRef: 'test-app',
  environment: 'live' as const,
};

function runtime(overrides: Partial<ResolvedPaymentRuntime> = {}): ResolvedPaymentRuntime {
  return {
    mode: 'live-provider',
    context,
    descriptor: { ...context, capabilities: [] },
    checkoutCredentials: {
      clientId: 'client-id-value',
      clientSecret: 'client-secret-value',
      environment: 'live',
    },
    ...overrides,
  };
}

const unconfigured: PaymentExecutionStatus = {
  runtimeState: 'unconfigured',
  deploymentEnvironment: 'live',
  executionMode: null,
  providerCallsEnabled: false,
  simulatedExecutionEnabled: false,
  source: 'unconfigured',
  issues: [],
};

type Build = (input: {
  runtime: ResolvedPaymentRuntime;
  nodeEnv?: string;
  executionStatus?: PaymentExecutionStatus;
  allowRejectOnlyInProduction?: boolean;
}) => unknown;

const factories: Array<[string, Build]> = [
  ['subscription', (input) => buildPaypalSubscriptionExecutor(input)],
  ['checkout', (input) => buildPaypalCheckoutExecutor({ ...input, strategyFactory: vi.fn() })],
  [
    'marketplace',
    (input) =>
      buildPaypalMarketplaceExecutor({ ...input, partnerConfig: { partnerAttributionId: 'bn' } }),
  ],
  ['payout', (input) => buildPaypalPayoutExecutor(input)],
  [
    'seller onboarding',
    (input) =>
      buildPaypalSellerOnboardingExecutor({
        ...input,
        partnerConfig: {
          partnerMerchantId: 'partner',
          partnerAttributionId: 'bn',
          returnUrl: 'https://example.com/return',
          products: ['EXPRESS_CHECKOUT'],
          features: ['PAYMENT'],
        },
      }),
  ],
  ['webhook verifier', (input) => buildPaypalWebhookVerifier({ ...input, webhookId: 'WH-1' })],
];

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('PayPal factories refuse a reject-only composition in production (#7)', () => {
  for (const [label, build] of factories) {
    it(`${label}: throws for a fake runtime without credentials`, () => {
      const error = captureError(() =>
        build({
          runtime: runtime({ mode: 'fake', checkoutCredentials: undefined }),
          nodeEnv: 'production',
        }),
      );
      expect(error).toBeInstanceOf(PaymentConfigurationError);
      expect((error as PaymentConfigurationError).missingFields).toEqual(
        expect.arrayContaining(['credentials.clientId', 'credentials.clientSecret']),
      );
    });

    it(`${label}: throws for an unconfigured executionStatus without printing secrets`, () => {
      const error = captureError(() =>
        build({ runtime: runtime(), nodeEnv: 'production', executionStatus: unconfigured }),
      );
      expect(error).toBeInstanceOf(PaymentConfigurationError);
      expect((error as PaymentConfigurationError).missingFields).toEqual(
        expect.arrayContaining(['executionStatus.runtimeState']),
      );
      expect(String((error as Error).message)).not.toContain('client-secret-value');
      expect(JSON.stringify(error)).not.toContain('client-secret-value');
    });

    it(`${label}: builds with credentials in production`, () => {
      expect(() => build({ runtime: runtime(), nodeEnv: 'production' })).not.toThrow();
    });

    it(`${label}: keeps the reject-only composition outside production`, () => {
      for (const nodeEnv of [undefined, 'development', 'prod']) {
        expect(() =>
          build({ runtime: runtime({ mode: 'fake', checkoutCredentials: undefined }), nodeEnv }),
        ).not.toThrow();
        expect(() =>
          build({ runtime: runtime(), nodeEnv, executionStatus: unconfigured }),
        ).not.toThrow();
      }
    });
  }
});

describe('buildPaypalWebhookVerifier webhook id check (#7)', () => {
  it('throws at build time in production when the webhook id is missing', () => {
    for (const webhookId of [undefined, '', '   ']) {
      const error = captureError(() =>
        buildPaypalWebhookVerifier({ runtime: runtime(), nodeEnv: 'production', webhookId }),
      );
      expect(error).toBeInstanceOf(PaymentConfigurationError);
      expect((error as PaymentConfigurationError).missingFields).toEqual(['webhookId']);
    }
  });

  it('does not require the webhook id outside production unless asked', () => {
    expect(() =>
      buildPaypalWebhookVerifier({ runtime: runtime(), nodeEnv: 'development' }),
    ).not.toThrow();
    expect(() =>
      buildPaypalWebhookVerifier({
        runtime: runtime(),
        nodeEnv: 'development',
        requireWebhookId: true,
      }),
    ).toThrow(PaymentConfigurationError);
  });

  it('allows a production host to opt out explicitly', () => {
    expect(() =>
      buildPaypalWebhookVerifier({
        runtime: runtime(),
        nodeEnv: 'production',
        requireWebhookId: false,
      }),
    ).not.toThrow();
  });
});

const killSwitch: PaymentExecutionStatus = {
  runtimeState: 'configured',
  deploymentEnvironment: 'live',
  executionMode: 'live',
  providerCallsEnabled: false,
  simulatedExecutionEnabled: false,
  source: 'provider-environment',
  issues: [],
};

describe('production escape hatches', () => {
  for (const [label, build] of factories) {
    it(`${label}: allowRejectOnlyInProduction builds a reject-only composition`, () => {
      expect(() =>
        build({
          runtime: runtime({ mode: 'fake', checkoutCredentials: undefined }),
          nodeEnv: 'production',
          allowRejectOnlyInProduction: true,
        }),
      ).not.toThrow();
      expect(() =>
        build({
          runtime: runtime(),
          nodeEnv: 'production',
          executionStatus: unconfigured,
          allowRejectOnlyInProduction: true,
        }),
      ).not.toThrow();
    });
  }

  for (const [label, build] of factories.filter(([name]) => name !== 'webhook verifier')) {
    it(`${label}: the kill switch still throws for executors without the opt-in`, () => {
      expect(() =>
        build({ runtime: runtime(), nodeEnv: 'production', executionStatus: killSwitch }),
      ).toThrow(PaymentConfigurationError);
    });
  }

  it('webhook verifier: the kill switch builds a verifier that answers verification_unavailable', async () => {
    const verifier = buildPaypalWebhookVerifier({
      runtime: runtime(),
      nodeEnv: 'production',
      executionStatus: killSwitch,
    });
    const result = await verifier.verify({
      providerCode: 'paypal',
      accountRef: 'default',
      environment: 'live',
      webhookId: 'WH-1',
      rawBody: '{"id":"WH-EV","event_type":"X","resource":{"id":"R"}}',
      headers: {
        transmissionId: 't',
        transmissionTime: '2026-10-22T00:00:00Z',
        certUrl: 'https://api.paypal.com/cert',
        authAlgo: 'SHA256withRSA',
        transmissionSig: 'sig',
      },
    });
    expect(result).toMatchObject({ verified: false, failureKind: 'verification_unavailable' });
  });

  it('webhook verifier: the kill switch with a runtime resolved in production stores webhooks as pending', async () => {
    const resolved = resolvePaymentRuntime({
      config: {
        environment: 'live',
        applicationRef: 'app',
        credentials: { clientId: 'client-id-value', clientSecret: 'client-secret-value' },
      },
      nodeEnv: 'production',
      executionStatus: killSwitch,
    });
    const verifier = buildPaypalWebhookVerifier({
      runtime: resolved,
      nodeEnv: 'production',
      executionStatus: killSwitch,
      webhookId: 'WH-1',
    });
    const store = new MemoryPaymentReliabilityStore();
    const service = new WebhookProcessingService(store);
    const rawBody = '{"id":"WH-EV","event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"R"}}';
    await expect(
      service.receiveWebhook({
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'app',
        environment: 'live',
        rawBody,
        verify: () =>
          verifier.verify({
            providerCode: 'paypal',
            accountRef: 'default',
            environment: 'live',
            webhookId: 'WH-1',
            rawBody,
            headers: {
              transmissionId: 't',
              transmissionTime: '2026-10-22T00:00:00Z',
              certUrl: 'https://api.paypal.com/cert',
              authAlgo: 'SHA256withRSA',
              transmissionSig: 'sig',
            },
          }),
      }),
    ).rejects.toMatchObject({ code: 'VERIFICATION_UNAVAILABLE' });
    expect(
      await store.findEvidenceByProviderEvent('paypal', 'default', 'live', 'WH-EV'),
    ).toMatchObject({ verificationStatus: 'pending', processingStatus: 'pending' });
  });
});
