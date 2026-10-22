import type { PaymentEnvironment, SubscriptionProviderContext } from '../../contracts/index';
import { requireApplicationRef } from './payment-configuration-error';

export type SubscriptionProviderConfigReader = (key: string) => string | undefined;

function requireProviderEnvironment(
  environment: PaymentEnvironment | undefined,
): PaymentEnvironment {
  if (environment === 'sandbox' || environment === 'live') {
    return environment;
  }
  throw new Error('Subscription provider environment must be supplied by the composition root');
}

/** Canonical Payment subscription provider scope resolution (single source of truth). */
export function resolvePaymentSubscriptionProviderContext(
  read: SubscriptionProviderConfigReader,
  overrides: Partial<
    Pick<
      SubscriptionProviderContext,
      'providerCode' | 'accountRef' | 'applicationRef' | 'environment'
    >
  > & { applicationRef: string },
): SubscriptionProviderContext {
  return {
    providerCode: overrides.providerCode?.trim() || read('PAYMENT_PROVIDER')?.trim() || 'paypal',
    accountRef: overrides.accountRef?.trim() || read('PAYPAL_ACCOUNT_REF')?.trim() || 'default',
    applicationRef: requireApplicationRef(overrides.applicationRef),
    environment: requireProviderEnvironment(overrides.environment),
  };
}
