import { describe, expect, it } from 'vitest';
import { evaluateCapabilities } from '../../../core/index';
import { sandboxPaypalProviderConfig } from '../../../../test/helpers/provider-config-fixtures';
import { FakePaypalSellerOnboardingHttpClient } from '../fake-paypal-seller-onboarding-http-client';
import { PaypalSellerOnboardingExecutor } from '../paypal-seller-onboarding-executor';
import type { ResolvedPaymentRuntime } from '../../../core/index';

const context = {
  providerCode: 'paypal',
  accountRef: 'default',
  applicationRef: 'app-1',
  environment: 'sandbox' as const,
};

function runtime(enabled: boolean): ResolvedPaymentRuntime {
  return {
    mode: 'live-provider',
    context,
    checkoutCredentials: {
      clientId: 'id',
      clientSecret: 'secret',
      environment: 'sandbox',
    },
    descriptor: {
      ...context,
      capabilities: evaluateCapabilities(
        sandboxPaypalProviderConfig({
          credentials: { clientId: 'set', clientSecret: 'set' },
          capabilityFlags: { seller_onboarding: enabled },
          partner: enabled
            ? {
                merchantId: 'set',
                attributionId: 'set',
                sellerOnboardingReturnUrl: 'https://example.com/return',
              }
            : undefined,
        }),
        context,
      ),
    },
  } as ResolvedPaymentRuntime;
}

describe('PaypalSellerOnboardingExecutor', () => {
  it('fails closed when the capability is disabled', async () => {
    const executor = new PaypalSellerOnboardingExecutor(
      runtime(false),
      new FakePaypalSellerOnboardingHttpClient(),
      async () => 'token',
      {
        partnerMerchantId: 'PARTNER',
        partnerAttributionId: 'BN',
        returnUrl: 'https://app.example/return',
        products: ['EXPRESS_CHECKOUT'],
        features: ['PAYMENT', 'REFUND'],
      },
    );
    await expect(
      executor.createReferral({
        ...context,
        providerRequestId: 'req-1',
        trackingId: 'seller-a',
      }),
    ).rejects.toMatchObject({ capability: 'seller_onboarding' });
  });

  it('creates a referral through the fake HTTP client when enabled', async () => {
    const executor = new PaypalSellerOnboardingExecutor(
      runtime(true),
      new FakePaypalSellerOnboardingHttpClient(),
      async () => 'token',
      {
        partnerMerchantId: 'PARTNER',
        partnerAttributionId: 'BN',
        returnUrl: 'https://app.example/return',
        products: ['EXPRESS_CHECKOUT'],
        features: ['PAYMENT', 'REFUND'],
      },
    );
    const result = await executor.createReferral({
      ...context,
      providerRequestId: 'req-1',
      trackingId: 'seller-a',
    });
    expect(result.providerReferralId).toBe('FAKE-REF-1');
    expect(result.actionUrl).toContain('onboardingentry');
  });

  it('returns ambiguous when tracking lookup matches more than one merchant integration', async () => {
    const ambiguousClient = {
      request: async (input: { method: string; path: string }) => {
        if (
          input.method === 'GET' &&
          input.path.includes('/merchant-integrations') &&
          input.path.includes('tracking_id=')
        ) {
          return {
            status: 200,
            body: {
              items: [
                { merchant_id: 'MERCHANT-1', tracking_id: 'seller-a' },
                { merchant_id: 'MERCHANT-2', tracking_id: 'seller-a' },
              ],
            },
            debugId: 'debug-ambiguous',
          };
        }
        return { status: 404, body: {}, debugId: 'debug-ambiguous' };
      },
    };
    const executor = new PaypalSellerOnboardingExecutor(
      runtime(true),
      ambiguousClient,
      async () => 'token',
      {
        partnerMerchantId: 'PARTNER',
        partnerAttributionId: 'BN',
        returnUrl: 'https://app.example/return',
        products: ['EXPRESS_CHECKOUT'],
        features: ['PAYMENT', 'REFUND'],
      },
    );
    const result = await executor.findMerchantByTrackingId({
      ...context,
      trackingId: 'seller-a',
    });
    expect(result.ambiguous).toBe(true);
    expect(result.matchCount).toBe(2);
    expect(result.providerMerchantId).toBeNull();
  });
});
