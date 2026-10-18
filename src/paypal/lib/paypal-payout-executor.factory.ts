import { formatEnvBanner, missingEnv } from '../../core/lib/host-env-banner';
import type { PaymentExecutionStatus } from '../../contracts/index';
import type { ResolvedPaymentRuntime } from '../../core/index';
import {
  blockedHttpClient,
  blockedOAuthGetter,
  isExecutionModeNetworkBlocked,
} from './build-reject-only-executor';
import { FakePaypalPayoutHttpClient } from './fake-paypal-payout-http-client';
import {
  FetchPaypalOAuthHttpClient,
  FetchPaypalPayoutHttpClient,
} from './live-paypal-http-clients';
import { PaypalOAuthClient } from './paypal-oauth-client';
import { PaypalPayoutExecutor } from './paypal-payout-executor';
import type { PaypalPayoutHttpClient } from './paypal-payout-http-client';

export type BuildPaypalPayoutExecutorInput = {
  runtime: ResolvedPaymentRuntime;
  nodeEnv?: string;
  envPath: string;
  executionStatus?: PaymentExecutionStatus;
  forceFakeHttp?: boolean;
  httpClient?: PaypalPayoutHttpClient;
};

export function buildPaypalPayoutExecutor(
  input: BuildPaypalPayoutExecutorInput,
): PaypalPayoutExecutor {
  const { runtime, nodeEnv, envPath, forceFakeHttp, httpClient, executionStatus } = input;
  const isProduction = nodeEnv === 'production';

  if (isExecutionModeNetworkBlocked(executionStatus)) {
    return new PaypalPayoutExecutor(runtime, blockedHttpClient(), blockedOAuthGetter());
  }

  if (forceFakeHttp) {
    if (isProduction) {
      throw new Error(
        formatEnvBanner({
          service: 'payment MS',
          provider: runtime.context.providerCode,
          missing: ['PRODUCTION_FAKE_HTTP_FORBIDDEN'],
          envPath,
          headline: '⚠  payment MS — fake PayPal payout HTTP is forbidden in production',
        }),
      );
    }
    return new PaypalPayoutExecutor(
      runtime,
      httpClient ?? new FakePaypalPayoutHttpClient(),
      async () => {
        throw {
          code: 'PROVIDER_AUTH_FAILURE',
          message: 'Fake PayPal payout HTTP cannot obtain OAuth tokens',
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
    return new PaypalPayoutExecutor(runtime, new FakePaypalPayoutHttpClient(), async () => {
      throw {
        code: 'PROVIDER_AUTH_FAILURE',
        message: 'PayPal payout HTTP is unavailable in unconfigured development mode',
        retryable: false,
        uncertain: false,
      };
    });
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
  const payoutHttp =
    httpClient ?? new FetchPaypalPayoutHttpClient(credentials.requestTimeoutMs ?? 10_000);

  return new PaypalPayoutExecutor(runtime, payoutHttp, (scope) =>
    oauthClient.getAccessToken({
      accountRef: scope.accountRef,
      environment: scope.environment,
    }),
  );
}
