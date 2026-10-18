import { formatEnvBanner, missingEnv } from '../../core/lib/host-env-banner';
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
import {
  PaypalMarketplaceExecutor,
  type PaypalMarketplacePartnerConfig,
} from './paypal-marketplace-executor';
import { PaypalOAuthClient } from './paypal-oauth-client';
import type { PaypalOrdersHttpClient } from './paypal-orders-http-client';

export type BuildPaypalMarketplaceExecutorInput = {
  runtime: ResolvedPaymentRuntime;
  nodeEnv?: string;
  envPath: string;
  executionStatus?: PaymentExecutionStatus;
  get?: (key: string) => string | undefined;
  forceFakeHttp?: boolean;
  httpClient?: PaypalOrdersHttpClient;
};

const MARKETPLACE_KEYS = [
  'PAYPAL_CLIENT_ID',
  'PAYPAL_CLIENT_SECRET',
  'PAYPAL_PARTNER_MERCHANT_ID',
  'PAYPAL_PARTNER_ATTRIBUTION_ID',
];

function readPartnerConfig(
  get: (key: string) => string | undefined,
): PaypalMarketplacePartnerConfig {
  return {
    partnerAttributionId: get('PAYPAL_PARTNER_ATTRIBUTION_ID')?.trim() || 'unconfigured',
  };
}

export function buildPaypalMarketplaceExecutor(
  input: BuildPaypalMarketplaceExecutorInput,
): PaypalMarketplaceExecutor {
  const { runtime, nodeEnv, envPath, forceFakeHttp, httpClient, executionStatus } = input;
  const isProduction = nodeEnv === 'production';
  const get = input.get ?? (() => undefined);
  const enabled = get('PAYPAL_MARKETPLACE_ENABLED')?.trim() === 'true';
  const partnerConfig = readPartnerConfig(get);

  if (isExecutionModeNetworkBlocked(executionStatus)) {
    return new PaypalMarketplaceExecutor(
      runtime,
      blockedHttpClient(),
      blockedOAuthGetter(),
      partnerConfig,
    );
  }

  if (enabled && isProduction) {
    const missing = missingEnv(get, MARKETPLACE_KEYS);
    if (missing.length > 0) {
      throw new Error(
        formatEnvBanner({
          service: 'payment MS',
          provider: runtime.context.providerCode,
          missing,
          envPath,
          headline: '⚠  payment MS — PayPal marketplace configuration missing (startup aborted)',
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
          headline: '⚠  payment MS — fake PayPal marketplace HTTP is forbidden in production',
        }),
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
    return new PaypalMarketplaceExecutor(
      runtime,
      new FakePaypalOrdersHttpClient(),
      async () => {
        throw {
          code: 'PROVIDER_AUTH_FAILURE',
          message: 'PayPal marketplace HTTP is unavailable in unconfigured development mode',
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
  const ordersHttp =
    httpClient ?? new FetchPaypalOrdersHttpClient(credentials.requestTimeoutMs ?? 10_000);

  return new PaypalMarketplaceExecutor(
    runtime,
    ordersHttp,
    (scope) =>
      oauthClient.getAccessToken({
        accountRef: scope.accountRef,
        environment: scope.environment,
      }),
    partnerConfig,
  );
}
