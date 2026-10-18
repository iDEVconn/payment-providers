import { describe, expect, it } from 'vitest';
import { evaluateCapabilities } from '../evaluate-capabilities';

const baseContext = {
  providerCode: 'paypal',
  accountRef: 'default',
  environment: 'sandbox' as const,
  applicationRef: 'edc',
};

function env(values: Record<string, string | undefined>) {
  return (key: string) => values[key];
}

describe('evaluateCapabilities', () => {
  it('reports checkout ready with unknown eligibility when credentials exist', () => {
    const rows = evaluateCapabilities(
      env({
        PAYPAL_CLIENT_ID: 'id',
        PAYPAL_CLIENT_SECRET: 'secret',
      }),
      baseContext,
    );
    const checkout = rows.find((row) => row.capability === 'checkout');
    expect(checkout).toMatchObject({
      implemented: true,
      enabled: true,
      configured: true,
      eligible: 'unknown',
      ready: true,
    });
  });

  it('does not require credentials for disabled payout capability', () => {
    const rows = evaluateCapabilities(env({}), baseContext);
    const payout = rows.find((row) => row.capability === 'payout');
    expect(payout).toMatchObject({
      implemented: true,
      enabled: false,
      configured: true,
      eligible: false,
      ready: false,
    });
  });

  it('marks enabled payout as not ready without credentials or eligible true', () => {
    const rows = evaluateCapabilities(env({ PAYPAL_PAYOUTS_ENABLED: 'true' }), baseContext);
    const payout = rows.find((row) => row.capability === 'payout');
    expect(payout).toMatchObject({
      implemented: true,
      enabled: true,
      configured: false,
      eligible: false,
      ready: false,
    });
    expect(payout?.eligible).not.toBe(true);
  });

  it('marks payout ready when enabled and credentials exist', () => {
    const rows = evaluateCapabilities(
      env({
        PAYPAL_PAYOUTS_ENABLED: 'true',
        PAYPAL_CLIENT_ID: 'id',
        PAYPAL_CLIENT_SECRET: 'secret',
      }),
      baseContext,
    );
    const payout = rows.find((row) => row.capability === 'payout');
    expect(payout).toMatchObject({
      implemented: true,
      enabled: true,
      configured: true,
      eligible: 'unknown',
      ready: true,
    });
  });

  it('marks checkout not ready when credentials are missing', () => {
    const rows = evaluateCapabilities(env({}), baseContext);
    const checkout = rows.find((row) => row.capability === 'checkout');
    expect(checkout).toMatchObject({
      configured: false,
      ready: false,
    });
  });

  it('marks subscription implemented but disabled by default', () => {
    const rows = evaluateCapabilities(
      env({
        PAYPAL_CLIENT_ID: 'id',
        PAYPAL_CLIENT_SECRET: 'secret',
      }),
      baseContext,
    );
    const subscription = rows.find((row) => row.capability === 'subscription');
    expect(subscription).toMatchObject({
      implemented: true,
      enabled: false,
      configured: true,
      eligible: false,
      ready: false,
    });
  });

  it('marks subscription ready when enabled and credentials exist', () => {
    const rows = evaluateCapabilities(
      env({
        PAYPAL_SUBSCRIPTIONS_ENABLED: 'true',
        PAYPAL_CLIENT_ID: 'id',
        PAYPAL_CLIENT_SECRET: 'secret',
      }),
      baseContext,
    );
    const subscription = rows.find((row) => row.capability === 'subscription');
    expect(subscription).toMatchObject({
      implemented: true,
      enabled: true,
      configured: true,
      eligible: 'unknown',
      ready: true,
    });
  });

  it('marks seller onboarding implemented but disabled by default', () => {
    const rows = evaluateCapabilities(
      env({
        PAYPAL_CLIENT_ID: 'id',
        PAYPAL_CLIENT_SECRET: 'secret',
      }),
      baseContext,
    );
    const seller = rows.find((row) => row.capability === 'seller_onboarding');
    expect(seller).toMatchObject({
      implemented: true,
      enabled: false,
      configured: true,
      eligible: false,
      ready: false,
    });
    expect(seller?.eligible).not.toBe(true);
  });

  it('keeps seller onboarding platform eligible unknown when enabled and configured', () => {
    const rows = evaluateCapabilities(
      env({
        PAYPAL_SELLER_ONBOARDING_ENABLED: 'true',
        PAYPAL_CLIENT_ID: 'id',
        PAYPAL_CLIENT_SECRET: 'secret',
        PAYPAL_PARTNER_MERCHANT_ID: 'partner',
        PAYPAL_PARTNER_ATTRIBUTION_ID: 'BN',
        PAYPAL_SELLER_ONBOARDING_RETURN_URL: 'https://app.example/return',
      }),
      baseContext,
    );
    const seller = rows.find((row) => row.capability === 'seller_onboarding');
    expect(seller?.eligible).toBe('unknown');
    expect(seller?.eligible).not.toBe(true);
  });

  it('does not treat seller onboarding as configured when enabled without partner vars', () => {
    const rows = evaluateCapabilities(
      env({
        PAYPAL_SELLER_ONBOARDING_ENABLED: 'true',
        PAYPAL_CLIENT_ID: 'id',
        PAYPAL_CLIENT_SECRET: 'secret',
      }),
      baseContext,
    );
    const seller = rows.find((row) => row.capability === 'seller_onboarding');
    expect(seller).toMatchObject({
      implemented: true,
      enabled: true,
      configured: false,
      eligible: false,
      ready: false,
    });
  });

  it('marks marketplace checkout implemented but disabled by default', () => {
    const rows = evaluateCapabilities(
      env({
        PAYPAL_CLIENT_ID: 'id',
        PAYPAL_CLIENT_SECRET: 'secret',
      }),
      baseContext,
    );
    const marketplace = rows.find((row) => row.capability === 'marketplace_checkout');
    expect(marketplace).toMatchObject({
      implemented: true,
      enabled: false,
      configured: true,
      eligible: false,
      ready: false,
    });
    expect(marketplace?.eligible).not.toBe(true);
  });

  it('keeps marketplace platform eligible unknown when enabled and configured', () => {
    const rows = evaluateCapabilities(
      env({
        PAYPAL_MARKETPLACE_ENABLED: 'true',
        PAYPAL_CLIENT_ID: 'id',
        PAYPAL_CLIENT_SECRET: 'secret',
        PAYPAL_PARTNER_MERCHANT_ID: 'partner',
        PAYPAL_PARTNER_ATTRIBUTION_ID: 'BN',
      }),
      baseContext,
    );
    const marketplace = rows.find((row) => row.capability === 'marketplace_checkout');
    expect(marketplace?.eligible).toBe('unknown');
    expect(marketplace?.eligible).not.toBe(true);
  });
});
