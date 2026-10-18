import { formatEnvBanner, missingEnv } from '../../core/lib/host-env-banner';
import type { PaymentStrategy } from '@idevconn/payment';
import type { PaymentExecutionStatus } from '../../contracts/index';
import type { ResolvedPaymentRuntime } from '../../core/index';
import {
  blockedHttpClient,
  blockedOAuthGetter,
  isExecutionModeNetworkBlocked,
} from './build-reject-only-executor';
import { FakePaypalOrdersHttpClient } from './fake-paypal-orders-http-client';
import {
  FetchPaypalOAuthHttpClient,
  FetchPaypalOrdersHttpClient,
} from './live-paypal-http-clients';
import { PaypalCheckoutExecutor } from './paypal-checkout-executor';
import { PaypalOAuthClient } from './paypal-oauth-client';

export type BuildPaypalCheckoutExecutorInput = {
  runtime: ResolvedPaymentRuntime;
  strategyFactory: () => PaymentStrategy;
  nodeEnv?: string;
  envPath: string;
  executionStatus?: PaymentExecutionStatus;
  /** Explicit test/dev simulation only. Never set in production composition. */
  forceFakeHttp?: boolean;
};

export function buildPaypalCheckoutExecutor(
  input: BuildPaypalCheckoutExecutorInput,
): PaypalCheckoutExecutor {
  const { runtime, strategyFactory, nodeEnv, envPath, forceFakeHttp, executionStatus } = input;
  const isProduction = nodeEnv === 'production';

  if (isExecutionModeNetworkBlocked(executionStatus)) {
    return new PaypalCheckoutExecutor(
      runtime,
      strategyFactory,
      blockedHttpClient(),
      blockedOAuthGetter(),
    );
  }

  if (forceFakeHttp) {
    if (isProduction) {
      throw new Error(
        formatEnvBanner({
          service: 'payment MS',
          provider: runtime.context.providerCode,
          missing: ['PRODUCTION_FAKE_HTTP_FORBIDDEN'],
          envPath,
          headline: '⚠  payment MS — fake PayPal HTTP is forbidden in production',
        }),
      );
    }
    return new PaypalCheckoutExecutor(
      runtime,
      strategyFactory,
      new FakePaypalOrdersHttpClient(),
      async () => {
        throw {
          code: 'PROVIDER_AUTH_FAILURE',
          message: 'Fake PayPal HTTP composition cannot obtain OAuth tokens',
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
    return new PaypalCheckoutExecutor(
      runtime,
      strategyFactory,
      new FakePaypalOrdersHttpClient(),
      async () => {
        throw {
          code: 'PROVIDER_AUTH_FAILURE',
          message: 'PayPal direct HTTP is unavailable in unconfigured development mode',
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

  const oauthHttp = new FetchPaypalOAuthHttpClient();
  const oauthClient = new PaypalOAuthClient(
    () => ({
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      environment: credentials.environment,
      requestTimeoutMs: credentials.requestTimeoutMs,
    }),
    oauthHttp,
  );
  const ordersHttp = new FetchPaypalOrdersHttpClient(credentials.requestTimeoutMs ?? 10_000);

  return new PaypalCheckoutExecutor(runtime, strategyFactory, ordersHttp, (scope) =>
    oauthClient.getAccessToken({
      accountRef: scope.accountRef,
      environment: scope.environment,
    }),
  );
}
