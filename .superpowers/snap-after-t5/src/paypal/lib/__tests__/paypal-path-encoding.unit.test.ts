import { describe, expect, it } from 'vitest';
import { evaluateCapabilities, type ResolvedPaymentRuntime } from '../../../core/index';
import { sandboxPaypalProviderConfig } from '../../../../test/helpers/provider-config-fixtures';
import { PaypalCheckoutExecutor } from '../paypal-checkout-executor';
import { PaypalMarketplaceExecutor } from '../paypal-marketplace-executor';
import { PaypalPayoutExecutor } from '../paypal-payout-executor';
import { PaypalSellerOnboardingExecutor } from '../paypal-seller-onboarding-executor';
import { PaypalSubscriptionExecutor } from '../paypal-subscription-executor';

const HOSTILE = '../../../v1/payments/payouts?x=';
const ENCODED = encodeURIComponent(HOSTILE);
const SANDBOX = 'https://api-m.sandbox.paypal.com';

const ctx = {
  providerCode: 'paypal',
  accountRef: 'default',
  applicationRef: 'test-app',
  environment: 'sandbox' as const,
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
          capabilityFlags: {
            subscription: true,
            checkout: true,
            refund: true,
            payout: true,
            seller_onboarding: true,
            marketplace_checkout: true,
          },
          partner: {
            merchantId: 'partner-merchant',
            attributionId: 'BN-TEST',
            sellerOnboardingReturnUrl: 'https://example.com/return',
          },
        }),
        ctx,
      ),
    },
    checkoutCredentials: { clientId: 'id', clientSecret: 'secret', environment: 'sandbox' },
  } as ResolvedPaymentRuntime;
}

function recorder() {
  const paths: string[] = [];
  return {
    paths,
    client: {
      request: async (input: { path: string }) => {
        paths.push(input.path);
        return { status: 404, body: {} };
      },
    },
  };
}

const token = async () => 'token';

/** The path must stay under the intended prefix and carry the id as one encoded segment. */
function expectContained(paths: string[], prefix: string, suffix = '') {
  expect(paths).toHaveLength(1);
  expect(paths[0]).toBe(`${SANDBOX}${prefix}${ENCODED}${suffix}`);
  expect(paths[0]).not.toContain('../');
}

async function swallow(promise: Promise<unknown>): Promise<void> {
  await promise.catch(() => undefined);
}

describe('PayPal executors encode ids interpolated into URL paths', () => {
  it('subscription executor: product, plan, subscription and lifecycle ids', async () => {
    const cases: Array<[(e: PaypalSubscriptionExecutor) => Promise<unknown>, string, string?]> = [
      [
        (e) => e.getProduct({ ...ctx, providerProductId: HOSTILE }),
        '/v1/catalogs/products/',
      ],
      [(e) => e.getPlan({ ...ctx, providerPlanId: HOSTILE }), '/v1/billing/plans/'],
      [
        (e) => e.getSubscription({ ...ctx, providerSubscriptionId: HOSTILE }),
        '/v1/billing/subscriptions/',
      ],
      [
        (e) => e.activatePlan({ ...ctx, providerPlanId: HOSTILE }),
        '/v1/billing/plans/',
        '/activate',
      ],
      [
        (e) => e.deactivatePlan({ ...ctx, providerPlanId: HOSTILE }),
        '/v1/billing/plans/',
        '/deactivate',
      ],
      [
        (e) => e.cancelSubscription({ ...ctx, providerSubscriptionId: HOSTILE, reason: 'r' }),
        '/v1/billing/subscriptions/',
        '/cancel',
      ],
      [
        (e) => e.suspendSubscription({ ...ctx, providerSubscriptionId: HOSTILE, reason: 'r' }),
        '/v1/billing/subscriptions/',
        '/suspend',
      ],
    ];
    for (const [call, prefix, suffix] of cases) {
      const { paths, client } = recorder();
      await swallow(call(new PaypalSubscriptionExecutor(runtime(), client, token)));
      expectContained(paths, prefix, suffix);
    }
  });

  it('checkout executor: order, capture, refund ids', async () => {
    const strategyFactory = () => ({}) as never;
    const cases: Array<[(e: PaypalCheckoutExecutor) => Promise<unknown>, string, string?]> = [
      [(e) => e.getOrder({ ...ctx, providerOrderId: HOSTILE }), '/v2/checkout/orders/'],
      [
        (e) => e.captureOrder({ ...ctx, providerRequestId: 'r', providerOrderId: HOSTILE }),
        '/v2/checkout/orders/',
        '/capture',
      ],
      [
        (e) => e.refundCapture({ ...ctx, providerRequestId: 'r', providerCaptureId: HOSTILE }),
        '/v2/payments/captures/',
        '/refund',
      ],
      [(e) => e.getRefund({ ...ctx, providerRefundId: HOSTILE }), '/v2/payments/refunds/'],
    ];
    for (const [call, prefix, suffix] of cases) {
      const { paths, client } = recorder();
      await swallow(call(new PaypalCheckoutExecutor(runtime(), strategyFactory, client, token)));
      expectContained(paths, prefix, suffix);
    }
  });

  it('marketplace executor: order, capture, refund ids', async () => {
    const cases: Array<[(e: PaypalMarketplaceExecutor) => Promise<unknown>, string, string?]> = [
      [(e) => e.getOrder({ ...ctx, providerOrderId: HOSTILE }), '/v2/checkout/orders/'],
      [
        (e) => e.captureOrder({ ...ctx, providerRequestId: 'r', providerOrderId: HOSTILE }),
        '/v2/checkout/orders/',
        '/capture',
      ],
      [
        (e) =>
          e.refundUnit({
            ...ctx,
            providerRequestId: 'r',
            providerCaptureId: HOSTILE,
          } as never),
        '/v2/payments/captures/',
        '/refund',
      ],
      [(e) => e.getRefund({ ...ctx, providerRefundId: HOSTILE }), '/v2/payments/refunds/'],
    ];
    for (const [call, prefix, suffix] of cases) {
      const { paths, client } = recorder();
      await swallow(
        call(
          new PaypalMarketplaceExecutor(runtime(), client, token, {
            partnerAttributionId: 'BN-TEST',
          }),
        ),
      );
      expectContained(paths, prefix, suffix);
    }
  });

  it('payout executor: batch and item ids', async () => {
    const cases: Array<[(e: PaypalPayoutExecutor) => Promise<unknown>, string, string?]> = [
      [(e) => e.getBatch({ ...ctx, providerPayoutBatchId: HOSTILE }), '/v1/payments/payouts/'],
      [(e) => e.getItem({ ...ctx, providerPayoutItemId: HOSTILE }), '/v1/payments/payouts-item/'],
      [
        (e) => e.cancelUnclaimedItem({ ...ctx, providerPayoutItemId: HOSTILE }),
        '/v1/payments/payouts-item/',
        '/cancel',
      ],
    ];
    for (const [call, prefix, suffix] of cases) {
      const { paths, client } = recorder();
      await swallow(call(new PaypalPayoutExecutor(runtime(), client, token)));
      expectContained(paths, prefix, suffix);
    }
  });

  it('payout executor: a duplicate-batch id returned by PayPal is encoded too', async () => {
    const paths: string[] = [];
    const client = {
      request: async (input: { path: string }) => {
        paths.push(input.path);
        if (paths.length === 1) {
          return {
            status: 422,
            body: {
              name: 'UNPROCESSABLE_ENTITY',
              details: [{ field: 'SENDER_BATCH_ID', issue: 'duplicate' }],
              batch_header: { payout_batch_id: HOSTILE },
            },
          };
        }
        return { status: 404, body: {} };
      },
    };
    await swallow(
      new PaypalPayoutExecutor(runtime(), client, token).submitBatch({
        ...ctx,
        providerRequestId: 'req',
        senderBatchId: 'batch-1',
        items: [
          {
            senderItemId: 'item-1',
            amount: { currency: 'USD', amountMinor: '1000' },
            recipientType: 'EMAIL',
            receiver: 'payee@example.com',
          },
        ],
      }),
    );
    expect(paths).toHaveLength(2);
    expect(paths[1]).toBe(`${SANDBOX}/v1/payments/payouts/${ENCODED}`);
  });

  it('seller onboarding executor: referral and merchant ids, partner id from config', async () => {
    const partnerConfig = {
      partnerMerchantId: HOSTILE,
      partnerAttributionId: 'BN',
      returnUrl: 'https://app.example/return',
      products: ['EXPRESS_CHECKOUT'],
      features: ['PAYMENT'],
    };
    const make = (client: ReturnType<typeof recorder>['client']) =>
      new PaypalSellerOnboardingExecutor(runtime(), client as never, token, {
        ...partnerConfig,
        partnerMerchantId: 'PARTNER',
      } as never);

    {
      const { paths, client } = recorder();
      await swallow(make(client).getReferral({ ...ctx, providerReferralId: HOSTILE }));
      expectContained(paths, '/v2/customer/partner-referrals/');
    }
    {
      const { paths, client } = recorder();
      await swallow(
        make(client).getMerchantStatus({ ...ctx, providerMerchantId: HOSTILE } as never),
      );
      expectContained(paths, '/v1/customer/partners/PARTNER/merchant-integrations/');
    }
    {
      const { paths, client } = recorder();
      await swallow(
        new PaypalSellerOnboardingExecutor(runtime(), client as never, token, partnerConfig as never)
          .getMerchantStatus({ ...ctx, providerMerchantId: 'M-1' } as never),
      );
      expect(paths).toEqual([
        `${SANDBOX}/v1/customer/partners/${ENCODED}/merchant-integrations/M-1`,
      ]);
    }
  });

  it('keeps ordinary ids readable', async () => {
    const { paths, client } = recorder();
    await swallow(
      new PaypalSubscriptionExecutor(runtime(), client, token).getSubscription({
        ...ctx,
        providerSubscriptionId: 'I-BW452GLLEP1G',
      }),
    );
    expect(paths).toEqual([`${SANDBOX}/v1/billing/subscriptions/I-BW452GLLEP1G`]);
  });
});

describe('PayPal executors refuse ids that are not a safe single path segment', () => {
  const calls: Array<[string, (id: string) => Promise<unknown>]> = [
    [
      'subscription',
      (id) =>
        new PaypalSubscriptionExecutor(runtime(), recorder().client, token).cancelSubscription({
          ...ctx,
          providerSubscriptionId: id,
          reason: 'r',
        }),
    ],
    [
      'plan',
      (id) =>
        new PaypalSubscriptionExecutor(runtime(), recorder().client, token).getPlan({
          ...ctx,
          providerPlanId: id,
        }),
    ],
    [
      'product',
      (id) =>
        new PaypalSubscriptionExecutor(runtime(), recorder().client, token).getProduct({
          ...ctx,
          providerProductId: id,
        }),
    ],
    [
      'checkout order',
      (id) =>
        new PaypalCheckoutExecutor(runtime(), () => ({}) as never, recorder().client, token).getOrder(
          { ...ctx, providerOrderId: id },
        ),
    ],
    [
      'marketplace order',
      (id) =>
        new PaypalMarketplaceExecutor(runtime(), recorder().client, token, {
          partnerAttributionId: 'BN-TEST',
        }).getOrder({ ...ctx, providerOrderId: id }),
    ],
    [
      'payout',
      (id) =>
        new PaypalPayoutExecutor(runtime(), recorder().client, token).getBatch({
          ...ctx,
          providerPayoutBatchId: id,
        }),
    ],
    [
      'seller onboarding',
      (id) =>
        new PaypalSellerOnboardingExecutor(runtime(), recorder().client as never, token, {
          partnerMerchantId: 'PARTNER',
          partnerAttributionId: 'BN',
          returnUrl: 'https://app.example/return',
          products: ['EXPRESS_CHECKOUT'],
          features: ['PAYMENT'],
        } as never).getReferral({ ...ctx, providerReferralId: id }),
    ],
  ];

  for (const [family, call] of calls) {
    it.each(['', '   ', '.', '..', 'I-ABC\u0000123', 'I-ABC\n123'])(
      `${family}: rejects %j before any request`,
      async (id) => {
        await expect(call(id)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      },
    );
  }

  it('encodes an id that already contains %2F again instead of decoding it', async () => {
    const { paths, client } = recorder();
    await swallow(
      new PaypalSubscriptionExecutor(runtime(), client, token).getSubscription({
        ...ctx,
        providerSubscriptionId: 'I-A%2Fb',
      }),
    );
    expect(paths).toEqual([`${SANDBOX}/v1/billing/subscriptions/I-A%252Fb`]);
  });

  it('passes a normal id through unchanged', async () => {
    const { paths, client } = recorder();
    await swallow(
      new PaypalPayoutExecutor(runtime(), client, token).getBatch({
        ...ctx,
        providerPayoutBatchId: 'I-ABC123',
      }),
    );
    expect(paths).toEqual([`${SANDBOX}/v1/payments/payouts/I-ABC123`]);
  });
});
