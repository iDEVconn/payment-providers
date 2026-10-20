import { PaymentConfigurationError } from '../../core/lib/payment-configuration-error';
import type { PaymentExecutionStatus } from '../../contracts/index';
import type { ResolvedPaymentRuntime } from '../../core/index';
import {
  blockedHttpClient,
  blockedOAuthGetter,
  shouldRejectProviderNetworkCalls,
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
  executionStatus?: PaymentExecutionStatus;
  forceFakeHttp?: boolean;
  httpClient?: PaypalPayoutHttpClient;
};

export function buildPaypalPayoutExecutor(
  input: BuildPaypalPayoutExecutorInput,
): PaypalPayoutExecutor {
  const { runtime, nodeEnv, forceFakeHttp, httpClient, executionStatus } = input;
  const isProduction = nodeEnv === 'production';

  if (shouldRejectProviderNetworkCalls(runtime, executionStatus)) {
    return new PaypalPayoutExecutor(runtime, blockedHttpClient(), blockedOAuthGetter());
  }

  if (forceFakeHttp) {
    if (isProduction) {
      throw new PaymentConfigurationError(
        'Fake PayPal payout HTTP is forbidden in production',
        ['forceFakeHttp'],
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

  const credentials = runtime.checkoutCredentials;
  if (!credentials) {
    return new PaypalPayoutExecutor(runtime, blockedHttpClient(), blockedOAuthGetter());
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
