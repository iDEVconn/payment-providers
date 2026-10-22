import { describe, expect, it, vi } from 'vitest';
import { EXECUTION_MODE_BLOCKED } from '../../../contracts/index';
import type { PaymentExecutionStatus } from '../../../contracts/index';
import { resolvePaymentRuntime } from '../../../core/index';
import { sandboxPaypalProviderConfig } from '../../../../test/helpers/provider-config-fixtures';
import { buildPaypalCheckoutExecutor } from '../paypal-checkout-executor.factory';
import { buildPaypalPayoutExecutor } from '../paypal-payout-executor.factory';
import { buildPaypalSubscriptionExecutor } from '../paypal-subscription-executor.factory';
import { buildPaypalSellerOnboardingExecutor } from '../paypal-seller-onboarding-executor.factory';
import { buildPaypalMarketplaceExecutor } from '../paypal-marketplace-executor.factory';
import { buildPaypalWebhookVerifier } from '../paypal-webhook-verifier.factory';
import { UnconfiguredFakeCheckoutStrategy } from '../unconfigured-fake-checkout.strategy';

const simulationStatus: PaymentExecutionStatus = {
  executionMode: 'simulation',
  deploymentEnvironment: 'local',
  runtimeState: 'configured',
  providerCallsEnabled: false,
  simulatedExecutionEnabled: true,
  source: 'explicit',
  issues: [],
};

const sandboxConfiguredStatus: PaymentExecutionStatus = {
  executionMode: 'sandbox',
  deploymentEnvironment: 'local',
  runtimeState: 'configured',
  providerCallsEnabled: true,
  simulatedExecutionEnabled: false,
  source: 'explicit',
  issues: [],
};

const sellerPartner = {
  partnerMerchantId: 'partner',
  partnerAttributionId: 'bn',
  returnUrl: 'https://example.com/return',
  products: ['EXPRESS_CHECKOUT'],
  features: ['PAYMENT', 'REFUND'],
};

const marketplacePartner = {
  partnerAttributionId: 'bn',
};

function runtime() {
  return resolvePaymentRuntime({
    config: sandboxPaypalProviderConfig({
      credentials: { clientId: 'set', clientSecret: 'set' },
      capabilityFlags: {
        payout: true,
        subscription: true,
        seller_onboarding: true,
        marketplace_checkout: true,
      },
      partner: {
        merchantId: 'partner',
        attributionId: 'bn',
        sellerOnboardingReturnUrl: 'https://example.com/return',
      },
    }),
    nodeEnv: 'development',
    executionStatus: sandboxConfiguredStatus,
  });
}

describe('provider network kill switch in simulation', () => {
  it('blocks checkout create via reject-only strategy and get via blocked OAuth', async () => {
    const executor = buildPaypalCheckoutExecutor({
      runtime: runtime(),
      strategyFactory: () => new UnconfiguredFakeCheckoutStrategy('paypal'),
      executionStatus: simulationStatus,
    });

    await expect(
      executor.createOrder({
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'test-app',
        environment: 'sandbox',
        providerRequestId: 'req-1',
        amount: { currency: 'USD', amountMinor: '100' },
      }),
    ).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    });

    await expect(
      executor.getOrder({
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'test-app',
        environment: 'sandbox',
        providerOrderId: 'order-1',
      }),
    ).rejects.toMatchObject({ code: EXECUTION_MODE_BLOCKED });
  });

  it('blocks payout OAuth', async () => {
    const executor = buildPaypalPayoutExecutor({
      runtime: runtime(),
      executionStatus: simulationStatus,
    });

    await expect(
      executor.submitBatch({
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'test-app',
        environment: 'sandbox',
        providerRequestId: 'req-2',
        senderBatchId: 'batch-1',
        emailSubject: 'test',
        emailMessage: 'test',
        items: [],
      }),
    ).rejects.toMatchObject({ code: EXECUTION_MODE_BLOCKED });
  });

  it('blocks subscription, seller, marketplace, and webhook verification HTTP', async () => {
    const common = {
      runtime: runtime(),
      executionStatus: simulationStatus,
    };

    const subscription = buildPaypalSubscriptionExecutor(common);
    const seller = buildPaypalSellerOnboardingExecutor({
      ...common,
      partnerConfig: sellerPartner,
    });
    const marketplace = buildPaypalMarketplaceExecutor({
      ...common,
      partnerConfig: marketplacePartner,
    });
    const webhook = buildPaypalWebhookVerifier(common);

    const oauthProbe = async (executor: {
      submitBatch?: (input: unknown) => Promise<unknown>;
      createProduct?: (input: unknown) => Promise<unknown>;
      createReferral?: (input: unknown) => Promise<unknown>;
      createOrder?: (input: unknown) => Promise<unknown>;
    }) => {
      if (executor.createProduct) {
        await expect(
          executor.createProduct({
            providerCode: 'paypal',
            accountRef: 'default',
            applicationRef: 'test-app',
            environment: 'sandbox',
            providerRequestId: 'req-3',
            name: 'Product',
            type: 'SERVICE',
          }),
        ).rejects.toMatchObject({ code: EXECUTION_MODE_BLOCKED });
      }
      if (executor.createReferral) {
        await expect(
          executor.createReferral({
            providerCode: 'paypal',
            accountRef: 'default',
            applicationRef: 'test-app',
            environment: 'sandbox',
            providerRequestId: 'req-4',
            trackingId: 'track-1',
          }),
        ).rejects.toMatchObject({ code: EXECUTION_MODE_BLOCKED });
      }
      if (executor.createOrder) {
        await expect(
          executor.createOrder({
            providerCode: 'paypal',
            accountRef: 'default',
            applicationRef: 'test-app',
            environment: 'sandbox',
            providerRequestId: 'req-5',
            amount: { currency: 'USD', amountMinor: '100' },
            payeeMerchantId: 'seller-1',
          }),
        ).rejects.toMatchObject({ code: EXECUTION_MODE_BLOCKED });
      }
    };

    await oauthProbe(subscription);
    await oauthProbe(seller);
    await oauthProbe(marketplace);

    const verifyResult = await webhook.verify({
      webhookId: 'WH-1',
      rawBody: '{"event_type":"PAYMENT.CAPTURE.COMPLETED"}',
      headers: {
        transmissionId: 'tx-1',
        transmissionTime: '2026-01-01T00:00:00Z',
        certUrl: 'https://example.test/cert',
        authAlgo: 'SHA256withRSA',
        transmissionSig: 'sig',
      },
    });
    expect(verifyResult.verified).toBe(false);
    expect(verifyResult.failureKind).toBe('verification_unavailable');
  });

  it('does not call fetch when simulation blocks provider network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('should not fetch'));
    const executor = buildPaypalCheckoutExecutor({
      runtime: runtime(),
      strategyFactory: () => new UnconfiguredFakeCheckoutStrategy('paypal'),
      executionStatus: simulationStatus,
    });

    await expect(
      executor.getOrder({
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'test-app',
        environment: 'sandbox',
        providerOrderId: 'order-1',
      }),
    ).rejects.toMatchObject({ code: EXECUTION_MODE_BLOCKED });

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
