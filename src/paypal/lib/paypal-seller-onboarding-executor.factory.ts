import { PaymentConfigurationError } from '../../core/lib/payment-configuration-error';
import type { PaymentExecutionStatus } from '../../contracts/index';
import type { ResolvedPaymentRuntime } from '../../core/index';
import {
  assertProviderNetworkAllowedInProduction,
  blockedHttpClient,
  blockedOAuthGetter,
  shouldRejectProviderNetworkCalls,
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
  partnerConfig: PaypalSellerOnboardingPartnerConfig;
  nodeEnv?: string;
  executionStatus?: PaymentExecutionStatus;
  /** See `resolvePaymentRuntime`: build a reject-only composition in production on purpose. */
  allowRejectOnlyInProduction?: boolean;
  forceFakeHttp?: boolean;
  httpClient?: PaypalSellerOnboardingHttpClient;
};

export function buildPaypalSellerOnboardingExecutor(
  input: BuildPaypalSellerOnboardingExecutorInput,
): PaypalSellerOnboardingExecutor {
  const { runtime, nodeEnv, forceFakeHttp, httpClient, executionStatus, partnerConfig } = input;
  const isProduction = nodeEnv === 'production';

  assertProviderNetworkAllowedInProduction({
    runtime,
    executionStatus,
    nodeEnv,
    component: 'PayPal seller onboarding executor',
    allowRejectOnlyInProduction: input.allowRejectOnlyInProduction,
  });

  if (shouldRejectProviderNetworkCalls(runtime, executionStatus)) {
    return new PaypalSellerOnboardingExecutor(
      runtime,
      blockedHttpClient(),
      blockedOAuthGetter(),
      partnerConfig,
    );
  }

  if (forceFakeHttp) {
    if (isProduction) {
      throw new PaymentConfigurationError(
        'Fake PayPal seller onboarding HTTP is forbidden in production',
        ['forceFakeHttp'],
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

  const credentials = runtime.checkoutCredentials;
  if (!credentials) {
    return new PaypalSellerOnboardingExecutor(
      runtime,
      blockedHttpClient(),
      blockedOAuthGetter(),
      partnerConfig,
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
    (scope, options) =>
      oauthClient.getAccessToken(
        {
          accountRef: scope.accountRef,
          environment: scope.environment,
        },
        options,
      ),
    partnerConfig,
  );
}
