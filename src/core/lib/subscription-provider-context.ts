import type { PaymentEnvironment, SubscriptionProviderContext } from '../../contracts/index';

export type SubscriptionProviderConfigReader = (key: string) => string | undefined;

/** Canonical Payment subscription provider scope resolution (single source of truth). */
export function resolvePaymentSubscriptionProviderContext(
  read: SubscriptionProviderConfigReader,
  overrides: Partial<
    Pick<
      SubscriptionProviderContext,
      'providerCode' | 'accountRef' | 'applicationRef' | 'environment'
    >
  > = {},
): SubscriptionProviderContext {
  return {
    providerCode: overrides.providerCode?.trim() || read('PAYMENT_PROVIDER')?.trim() || 'paypal',
    accountRef: overrides.accountRef?.trim() || read('PAYPAL_ACCOUNT_REF')?.trim() || 'default',
    applicationRef:
      overrides.applicationRef?.trim() || read('PAYMENT_APPLICATION_REF')?.trim() || 'edc',
    environment: (overrides.environment ??
      (read('PAYPAL_ENVIRONMENT')?.trim() === 'live' ? 'live' : 'sandbox')) as PaymentEnvironment,
  };
}
