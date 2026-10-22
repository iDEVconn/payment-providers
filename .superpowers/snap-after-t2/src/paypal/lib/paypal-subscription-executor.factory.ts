import { PaymentConfigurationError } from '../../core/lib/payment-configuration-error';
import type { PaymentExecutionStatus } from '../../contracts/index';
import type { ResolvedPaymentRuntime } from '../../core/index';
import {
  blockedHttpClient,
  blockedOAuthGetter,
  shouldRejectProviderNetworkCalls,
} from './build-reject-only-executor';
import { FakePaypalSubscriptionHttpClient } from './fake-paypal-subscription-http-client';
import {
  FetchPaypalOAuthHttpClient,
  FetchPaypalSubscriptionHttpClient,
} from './live-paypal-http-clients';
import { PaypalOAuthClient } from './paypal-oauth-client';
import { PaypalSubscriptionExecutor } from './paypal-subscription-executor';
import type { PaypalSubscriptionHttpClient } from './paypal-subscription-http-client';

export type BuildPaypalSubscriptionExecutorInput = {
  runtime: ResolvedPaymentRuntime;
  nodeEnv?: string;
  executionStatus?: PaymentExecutionStatus;
  forceFakeHttp?: boolean;
  httpClient?: PaypalSubscriptionHttpClient;
};

export function buildPaypalSubscriptionExecutor(
  input: BuildPaypalSubscriptionExecutorInput,
): PaypalSubscriptionExecutor {
  const { runtime, nodeEnv, forceFakeHttp, httpClient, executionStatus } = input;
  const isProduction = nodeEnv === 'production';

  if (shouldRejectProviderNetworkCalls(runtime, executionStatus)) {
    return new PaypalSubscriptionExecutor(runtime, blockedHttpClient(), blockedOAuthGetter());
  }

  if (forceFakeHttp) {
    if (isProduction) {
      throw new PaymentConfigurationError(
        'Fake PayPal subscription HTTP is forbidden in production',
        ['forceFakeHttp'],
      );
    }
    return new PaypalSubscriptionExecutor(
      runtime,
      httpClient ?? new FakePaypalSubscriptionHttpClient(),
      async () => {
        throw {
          code: 'PROVIDER_AUTH_FAILURE',
          message: 'Fake PayPal subscription HTTP cannot obtain OAuth tokens',
          retryable: false,
          uncertain: false,
        };
      },
    );
  }

  const credentials = runtime.checkoutCredentials;
  if (!credentials) {
    return new PaypalSubscriptionExecutor(runtime, blockedHttpClient(), blockedOAuthGetter());
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
  const subscriptionHttp =
    httpClient ?? new FetchPaypalSubscriptionHttpClient(credentials.requestTimeoutMs ?? 10_000);

  return new PaypalSubscriptionExecutor(runtime, subscriptionHttp, (scope) =>
    oauthClient.getAccessToken({
      accountRef: scope.accountRef,
      environment: scope.environment,
    }),
  );
}
