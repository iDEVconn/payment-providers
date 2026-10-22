import { describe, expect, it } from 'vitest';
import type { PaymentProviderConfig } from '../payment-provider-config';
import { sandboxPaypalProviderConfig } from '../../../../test/helpers/provider-config-fixtures';
import { evaluateCapabilities } from '../evaluate-capabilities';

const baseContext = {
  providerCode: 'paypal',
  accountRef: 'default',
  environment: 'sandbox' as const,
  applicationRef: 'test-app',
};

function config(patch: Partial<PaymentProviderConfig> = {}): PaymentProviderConfig {
  return sandboxPaypalProviderConfig(patch);
}

describe('evaluateCapabilities', () => {
  it('reports checkout ready with unknown eligibility when credentials exist', () => {
    const rows = evaluateCapabilities(
      config({
        credentials: { clientId: 'id', clientSecret: 'secret' },
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
    const rows = evaluateCapabilities(config(), baseContext);
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
    const rows = evaluateCapabilities(
      config({ capabilityFlags: { payout: true } }),
      baseContext,
    );
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
      config({
        capabilityFlags: { payout: true },
        credentials: { clientId: 'id', clientSecret: 'secret' },
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
    const rows = evaluateCapabilities(config(), baseContext);
    const checkout = rows.find((row) => row.capability === 'checkout');
    expect(checkout).toMatchObject({
      configured: false,
      ready: false,
    });
  });

  it('marks subscription enabled but not ready without credentials when flag is absent', () => {
    const rows = evaluateCapabilities(config(), baseContext);
    const subscription = rows.find((row) => row.capability === 'subscription');
    expect(subscription).toMatchObject({
      enabled: true,
      configured: false,
      ready: false,
    });
  });

  it('marks subscription enabled by default when subscription flag is absent', () => {
    const rows = evaluateCapabilities(
      config({
        credentials: { clientId: 'id', clientSecret: 'secret' },
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

  it('marks subscription disabled when subscription flag is false', () => {
    const rows = evaluateCapabilities(
      config({
        capabilityFlags: { subscription: false },
        credentials: { clientId: 'id', clientSecret: 'secret' },
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

  it('marks subscription ready when explicitly enabled and credentials exist', () => {
    const rows = evaluateCapabilities(
      config({
        capabilityFlags: { subscription: true },
        credentials: { clientId: 'id', clientSecret: 'secret' },
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
      config({
        credentials: { clientId: 'id', clientSecret: 'secret' },
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
      config({
        capabilityFlags: { seller_onboarding: true },
        credentials: { clientId: 'id', clientSecret: 'secret' },
        partner: {
          merchantId: 'partner',
          attributionId: 'BN',
          sellerOnboardingReturnUrl: 'https://app.example/return',
        },
      }),
      baseContext,
    );
    const seller = rows.find((row) => row.capability === 'seller_onboarding');
    expect(seller?.eligible).toBe('unknown');
    expect(seller?.eligible).not.toBe(true);
  });

  it('does not treat seller onboarding as configured when enabled without partner vars', () => {
    const rows = evaluateCapabilities(
      config({
        capabilityFlags: { seller_onboarding: true },
        credentials: { clientId: 'id', clientSecret: 'secret' },
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
      config({
        credentials: { clientId: 'id', clientSecret: 'secret' },
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
      config({
        capabilityFlags: { marketplace_checkout: true },
        credentials: { clientId: 'id', clientSecret: 'secret' },
        partner: {
          merchantId: 'partner',
          attributionId: 'BN',
        },
      }),
      baseContext,
    );
    const marketplace = rows.find((row) => row.capability === 'marketplace_checkout');
    expect(marketplace?.eligible).toBe('unknown');
    expect(marketplace?.eligible).not.toBe(true);
  });
});
