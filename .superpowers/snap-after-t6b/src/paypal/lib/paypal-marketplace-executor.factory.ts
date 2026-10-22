import { PaymentConfigurationError } from '../../core/lib/payment-configuration-error';
import type { PaymentExecutionStatus } from '../../contracts/index';
import type { ResolvedPaymentRuntime } from '../../core/index';
import {
  assertProviderNetworkAllowedInProduction,
  blockedHttpClient,
  blockedOAuthGetter,
  shouldRejectProviderNetworkCalls,
} from './build-reject-only-executor';
import { FakePaypalOrdersHttpClient } from './fake-paypal-orders-http-client';
import {
  FetchPaypalOAuthHttpClient,
  FetchPaypalOrdersHttpClient,
} from './live-paypal-http-clients';
import {
  PaypalMarketplaceExecutor,
  type PaypalMarketplacePartnerConfig,
} from './paypal-marketplace-executor';
import { PaypalOAuthClient } from './paypal-oauth-client';
import type { PaypalOrdersHttpClient } from './paypal-orders-http-client';

export type BuildPaypalMarketplaceExecutorInput = {
  runtime: ResolvedPaymentRuntime;
  partnerConfig: PaypalMarketplacePartnerConfig;
  nodeEnv?: string;
  executionStatus?: PaymentExecutionStatus;
  /** See `resolvePaymentRuntime`: build a reject-only composition in production on purpose. */
  allowRejectOnlyInProduction?: boolean;
  forceFakeHttp?: boolean;
  httpClient?: PaypalOrdersHttpClient;
};

export function buildPaypalMarketplaceExecutor(
  input: BuildPaypalMarketplaceExecutorInput,
): PaypalMarketplaceExecutor {
  const { runtime, nodeEnv, forceFakeHttp, httpClient, executionStatus, partnerConfig } = input;
  const isProduction = nodeEnv === 'production';

  assertProviderNetworkAllowedInProduction({
    runtime,
    executionStatus,
    nodeEnv,
    component: 'PayPal marketplace executor',
    allowRejectOnlyInProduction: input.allowRejectOnlyInProduction,
  });

  if (shouldRejectProviderNetworkCalls(runtime, executionStatus)) {
    return new PaypalMarketplaceExecutor(
      runtime,
      blockedHttpClient(),
      blockedOAuthGetter(),
      partnerConfig,
    );
  }

  if (forceFakeHttp) {
    if (isProduction) {
      throw new PaymentConfigurationError(
        'Fake PayPal marketplace HTTP is forbidden in production',
        ['forceFakeHttp'],
      );
    }
    return new PaypalMarketplaceExecutor(
      runtime,
      httpClient ?? new FakePaypalOrdersHttpClient(),
      async () => {
        throw {
          code: 'PROVIDER_AUTH_FAILURE',
          message: 'Fake PayPal marketplace HTTP cannot obtain OAuth tokens',
          retryable: false,
          uncertain: false,
        };
      },
      partnerConfig,
    );
  }

  const credentials = runtime.checkoutCredentials;
  if (!credentials) {
    return new PaypalMarketplaceExecutor(
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
  const ordersHttp =
    httpClient ?? new FetchPaypalOrdersHttpClient(credentials.requestTimeoutMs ?? 10_000);

  return new PaypalMarketplaceExecutor(
    runtime,
    ordersHttp,
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
