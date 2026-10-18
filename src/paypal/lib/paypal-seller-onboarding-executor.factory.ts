import { formatEnvBanner, missingEnv } from '../../core/lib/host-env-banner';
import type { PaymentExecutionStatus } from '../../contracts/index';
import type { ResolvedPaymentRuntime } from '../../core/index';
import {
  blockedHttpClient,
  blockedOAuthGetter,
  isExecutionModeNetworkBlocked,
} from './build-reject-only-executor';
import { FakePaypalSellerOnboardingHttpClient } from './fake-paypal-seller-onboarding-http-client';
import {
  FetchPaypalOAuthHttpClient,
  FetchPaypalSellerOnboardingHttpClient,
} from './live-paypal-http-clients';
import { PaypalOAuthClient } from './paypal-oauth-client';
import {
  PaypalSellerOnboardingExecutor,
  type PaypalSellerOnboardingPartnerConfig,
} from './paypal-seller-onboarding-executor';
import type { PaypalSellerOnboardingHttpClient } from './paypal-seller-onboarding-http-client';

export type BuildPaypalSellerOnboardingExecutorInput = {
  runtime: ResolvedPaymentRuntime;
  nodeEnv?: string;
  envPath: string;
  executionStatus?: PaymentExecutionStatus;
  get?: (key: string) => string | undefined;
  forceFakeHttp?: boolean;
  httpClient?: PaypalSellerOnboardingHttpClient;
};

const PARTNER_KEYS = [
  'PAYPAL_CLIENT_ID',
  'PAYPAL_CLIENT_SECRET',
  'PAYPAL_PARTNER_MERCHANT_ID',
  'PAYPAL_PARTNER_ATTRIBUTION_ID',
  'PAYPAL_SELLER_ONBOARDING_RETURN_URL',
];

function readPartnerConfig(
  get: (key: string) => string | undefined,
): PaypalSellerOnboardingPartnerConfig {
  const products = (get('PAYPAL_SELLER_ONBOARDING_PRODUCTS') ?? 'EXPRESS_CHECKOUT')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const features = (get('PAYPAL_SELLER_ONBOARDING_FEATURES') ?? 'PAYMENT,REFUND')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    partnerMerchantId: get('PAYPAL_PARTNER_MERCHANT_ID')?.trim() || 'unconfigured',
    partnerAttributionId: get('PAYPAL_PARTNER_ATTRIBUTION_ID')?.trim() || 'unconfigured',
    returnUrl: get('PAYPAL_SELLER_ONBOARDING_RETURN_URL')?.trim() || 'https://invalid.local',
    products: products.length > 0 ? products : ['EXPRESS_CHECKOUT'],
    features: features.length > 0 ? features : ['PAYMENT', 'REFUND'],
  };
}

export function buildPaypalSellerOnboardingExecutor(
  input: BuildPaypalSellerOnboardingExecutorInput,
): PaypalSellerOnboardingExecutor {
  const { runtime, nodeEnv, envPath, forceFakeHttp, httpClient, executionStatus } = input;
  const isProduction = nodeEnv === 'production';
  const get = input.get ?? (() => undefined);
  const enabled = get('PAYPAL_SELLER_ONBOARDING_ENABLED')?.trim() === 'true';
  const partnerConfig = readPartnerConfig(get);

  if (isExecutionModeNetworkBlocked(executionStatus)) {
    return new PaypalSellerOnboardingExecutor(
      runtime,
      blockedHttpClient(),
      blockedOAuthGetter(),
      partnerConfig,
    );
  }

  if (enabled && isProduction) {
    const missing = missingEnv(get, PARTNER_KEYS);
    if (missing.length > 0) {
      throw new Error(
        formatEnvBanner({
          service: 'payment MS',
          provider: runtime.context.providerCode,
          missing,
          envPath,
          headline:
            '⚠  payment MS — PayPal seller onboarding configuration missing (startup aborted)',
        }),
      );
    }
  }

  if (forceFakeHttp) {
    if (isProduction) {
      throw new Error(
        formatEnvBanner({
          service: 'payment MS',
          provider: runtime.context.providerCode,
          missing: ['PRODUCTION_FAKE_HTTP_FORBIDDEN'],
          envPath,
          headline:
            '⚠  payment MS — fake PayPal seller onboarding HTTP is forbidden in production',
        }),
      );
    }
    return new PaypalSellerOnboardingExecutor(
      runtime,
      httpClient ?? new FakePaypalSellerOnboardingHttpClient(),
      async () => {
        throw {
          code: 'PROVIDER_AUTH_FAILURE',
          message: 'Fake PayPal seller onboarding HTTP cannot obtain OAuth tokens',
          retryable: false,
          uncertain: false,
        };
      },
      partnerConfig,
    );
  }

  if (runtime.mode === 'fake') {
    if (isProduction) {
      const missing = missingEnv(get, ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET']);
      throw new Error(
        formatEnvBanner({
          service: 'payment MS',
          provider: runtime.context.providerCode,
          missing,
          envPath,
          headline: '⚠  payment MS — PayPal credentials missing (startup aborted)',
        }),
      );
    }
    return new PaypalSellerOnboardingExecutor(
      runtime,
      new FakePaypalSellerOnboardingHttpClient(),
      async () => {
        throw {
          code: 'PROVIDER_AUTH_FAILURE',
          message: 'PayPal seller onboarding HTTP is unavailable in unconfigured development mode',
          retryable: false,
          uncertain: false,
        };
      },
      partnerConfig,
    );
  }

  const credentials = runtime.checkoutCredentials;
  if (!credentials) {
    const missing = missingEnv(get, ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET']);
    throw new Error(
      formatEnvBanner({
        service: 'payment MS',
        provider: runtime.context.providerCode,
        missing,
        envPath,
        headline: '⚠  payment MS — PayPal credentials missing (startup aborted)',
      }),
    );
  }

  const oauthClient = new PaypalOAuthClient(
    () => ({
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      environment: credentials.environment,
      requestTimeoutMs: credentials.requestTimeoutMs,
    }),
    new FetchPaypalOAuthHttpClient(),
  );
  const sellerHttp =
    httpClient ?? new FetchPaypalSellerOnboardingHttpClient(credentials.requestTimeoutMs ?? 10_000);

  return new PaypalSellerOnboardingExecutor(
    runtime,
    sellerHttp,
    (scope) =>
      oauthClient.getAccessToken({
        accountRef: scope.accountRef,
        environment: scope.environment,
      }),
    partnerConfig,
  );
}
