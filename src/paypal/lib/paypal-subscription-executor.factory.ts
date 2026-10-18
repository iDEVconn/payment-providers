import { formatEnvBanner, missingEnv } from '../../core/lib/host-env-banner';
import type { PaymentExecutionStatus } from '../../contracts/index';
import type { ResolvedPaymentRuntime } from '../../core/index';
import {
  blockedHttpClient,
  blockedOAuthGetter,
  isExecutionModeNetworkBlocked,
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
  envPath: string;
  executionStatus?: PaymentExecutionStatus;
  forceFakeHttp?: boolean;
  httpClient?: PaypalSubscriptionHttpClient;
};

export function buildPaypalSubscriptionExecutor(
  input: BuildPaypalSubscriptionExecutorInput,
): PaypalSubscriptionExecutor {
  const { runtime, nodeEnv, envPath, forceFakeHttp, httpClient, executionStatus } = input;
  const isProduction = nodeEnv === 'production';

  if (isExecutionModeNetworkBlocked(executionStatus)) {
    return new PaypalSubscriptionExecutor(runtime, blockedHttpClient(), blockedOAuthGetter());
  }

  if (forceFakeHttp) {
    if (isProduction) {
      throw new Error(
        formatEnvBanner({
          service: 'payment MS',
          provider: runtime.context.providerCode,
          missing: ['PRODUCTION_FAKE_HTTP_FORBIDDEN'],
          envPath,
          headline: '⚠  payment MS — fake PayPal subscription HTTP is forbidden in production',
        }),
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

  if (runtime.mode === 'fake') {
    if (isProduction) {
      const missing = missingEnv(() => undefined, ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET']);
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
    return new PaypalSubscriptionExecutor(
      runtime,
      new FakePaypalSubscriptionHttpClient(),
      async () => {
        throw {
          code: 'PROVIDER_AUTH_FAILURE',
          message: 'PayPal subscription HTTP is unavailable in unconfigured development mode',
          retryable: false,
          uncertain: false,
        };
      },
    );
  }

  const credentials = runtime.checkoutCredentials;
  if (!credentials) {
    const missing = missingEnv(() => undefined, ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET']);
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
  const subscriptionHttp =
    httpClient ?? new FetchPaypalSubscriptionHttpClient(credentials.requestTimeoutMs ?? 10_000);

  return new PaypalSubscriptionExecutor(runtime, subscriptionHttp, (scope) =>
    oauthClient.getAccessToken({
      accountRef: scope.accountRef,
      environment: scope.environment,
    }),
  );
}
