import { describe, expect, it, vi } from 'vitest';
import { EXECUTION_MODE_BLOCKED } from '../../../contracts/index';
import type { PaymentExecutionStatus } from '../../../contracts/index';
import { resolvePaymentRuntime } from '../../../core/index';
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

function env(key: string): string | undefined {
  if (key === 'PAYPAL_CLIENT_ID' || key === 'PAYPAL_CLIENT_SECRET') return 'set';
  if (key === 'PAYPAL_ENVIRONMENT') return 'sandbox';
  if (
    key === 'PAYPAL_PAYOUTS_ENABLED' ||
    key === 'PAYPAL_SUBSCRIPTIONS_ENABLED' ||
    key === 'PAYPAL_SELLER_ONBOARDING_ENABLED' ||
    key === 'PAYPAL_MARKETPLACE_ENABLED'
  ) {
    return 'true';
  }
  if (key === 'PAYPAL_PARTNER_MERCHANT_ID') return 'partner';
  if (key === 'PAYPAL_PARTNER_ATTRIBUTION_ID') return 'bn';
  if (key === 'PAYPAL_SELLER_ONBOARDING_RETURN_URL') return 'https://example.com/return';
  return undefined;
}

function runtime() {
  return resolvePaymentRuntime({
    get: env,
    nodeEnv: 'development',
    executionStatus: sandboxConfiguredStatus,
  });
}

describe('provider network kill switch in simulation', () => {
  it('blocks checkout create via reject-only strategy and get via blocked OAuth', async () => {
    const executor = buildPaypalCheckoutExecutor({
      runtime: runtime(),
      strategyFactory: () => new UnconfiguredFakeCheckoutStrategy('paypal'),
      envPath: 'apps/microservices/payment/.env',
      executionStatus: simulationStatus,
    });

    await expect(
      executor.createOrder({
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'edc',
        environment: 'sandbox',
        providerRequestId: 'req-1',
        amount: { currency: 'USD', amountMinor: '100' },
      }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_AUTH_FAILURE',
    });

    await expect(
      executor.getOrder({
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'edc',
        environment: 'sandbox',
        providerOrderId: 'order-1',
      }),
    ).rejects.toMatchObject({ code: EXECUTION_MODE_BLOCKED });
  });

  it('blocks payout OAuth', async () => {
    const executor = buildPaypalPayoutExecutor({
      runtime: runtime(),
      envPath: 'apps/microservices/payment/.env',
      executionStatus: simulationStatus,
    });

    await expect(
      executor.submitBatch({
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'edc',
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
      envPath: 'apps/microservices/payment/.env',
      executionStatus: simulationStatus,
    };

    const subscription = buildPaypalSubscriptionExecutor(common);
    const seller = buildPaypalSellerOnboardingExecutor(common);
    const marketplace = buildPaypalMarketplaceExecutor(common);
    const webhook = buildPaypalWebhookVerifier(common);

    const oauthProbe = async (executor: {
      submitBatch?: (input: unknown) => Promise<unknown>;
      createProduct?: (input: unknown) => Promise<unknown>;
      createReferral?: (input: unknown) => Promise<unknown>;
      createOrder?: (input: unknown) => Promise<unknown>;
      verify?: (input: unknown) => Promise<unknown>;
    }) => {
      if (executor.submitBatch) {
        await executor.submitBatch({
          providerCode: 'paypal',
          accountRef: 'default',
          applicationRef: 'edc',
          environment: 'sandbox',
          providerRequestId: 'req',
          senderBatchId: 'batch',
          emailSubject: 's',
          emailMessage: 'm',
          items: [],
        });
      }
      if (executor.createProduct) {
        await executor.createProduct({
          providerCode: 'paypal',
          accountRef: 'default',
          applicationRef: 'edc',
          environment: 'sandbox',
          providerRequestId: 'req',
          name: 'n',
          type: 'SERVICE',
        });
      }
      if (executor.createReferral) {
        await executor.createReferral({
          providerCode: 'paypal',
          accountRef: 'default',
          applicationRef: 'edc',
          environment: 'sandbox',
          providerRequestId: 'req',
          sellerRef: 'seller-1',
          trackingId: 'track-1',
        });
      }
      if (executor.createOrder) {
        await executor.createOrder({
          providerCode: 'paypal',
          accountRef: 'default',
          applicationRef: 'edc',
          environment: 'sandbox',
          providerRequestId: 'req',
          purchaseUnits: [],
        });
      }
      if (executor.verify) {
        await executor.verify({
          providerCode: 'paypal',
          accountRef: 'default',
          applicationRef: 'edc',
          environment: 'sandbox',
          webhookId: 'wh',
          headers: {
            transmissionId: 't',
            transmissionTime: 'now',
            certUrl: 'https://example.com',
            authAlgo: 'SHA256withRSA',
            transmissionSig: 'sig',
          },
          rawBody: '{}',
        });
      }
    };

    await expect(oauthProbe(subscription)).rejects.toMatchObject({ code: EXECUTION_MODE_BLOCKED });
    await expect(oauthProbe(seller)).rejects.toMatchObject({ code: EXECUTION_MODE_BLOCKED });
    await expect(oauthProbe(marketplace)).rejects.toMatchObject({ code: EXECUTION_MODE_BLOCKED });
    await expect(oauthProbe(webhook)).rejects.toMatchObject({ code: EXECUTION_MODE_BLOCKED });
  });

  it('does not call fetch in simulation composition', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    const executor = buildPaypalCheckoutExecutor({
      runtime: runtime(),
      strategyFactory: () => new UnconfiguredFakeCheckoutStrategy('paypal'),
      envPath: 'apps/microservices/payment/.env',
      executionStatus: simulationStatus,
    });

    await expect(
      executor.getOrder({
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'edc',
        environment: 'sandbox',
        providerOrderId: 'order-1',
      }),
    ).rejects.toBeTruthy();

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
