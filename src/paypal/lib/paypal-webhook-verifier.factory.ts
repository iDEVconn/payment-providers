import { formatEnvBanner, missingEnv } from '../../core/lib/host-env-banner';
import type { PaymentExecutionStatus } from '../../contracts/index';
import type { ResolvedPaymentRuntime } from '../../core/index';
import { createBlockedWebhookVerificationClient } from './blocked-provider-network';
import { isExecutionModeNetworkBlocked } from './build-reject-only-executor';
import { FakePaypalWebhookVerificationClient } from './fake-paypal-webhook-verification-client';
import { FetchPaypalOAuthHttpClient } from './live-paypal-http-clients';
import { LivePaypalWebhookVerificationClient } from './live-paypal-webhook-verification-client';
import { PaypalOAuthClient } from './paypal-oauth-client';
import { PaypalWebhookVerifier } from './paypal-webhook-verifier';

export type BuildPaypalWebhookVerifierInput = {
  runtime: ResolvedPaymentRuntime;
  nodeEnv?: string;
  envPath: string;
  executionStatus?: PaymentExecutionStatus;
  forceFake?: boolean;
};

export function buildPaypalWebhookVerifier(
  input: BuildPaypalWebhookVerifierInput,
): PaypalWebhookVerifier {
  const { runtime, nodeEnv, envPath, forceFake, executionStatus } = input;
  const isProduction = nodeEnv === 'production';

  if (isExecutionModeNetworkBlocked(executionStatus)) {
    return new PaypalWebhookVerifier(
      runtime,
      createBlockedWebhookVerificationClient(),
      nodeEnv,
      envPath,
    );
  }

  if (forceFake) {
    if (isProduction) {
      throw new Error(
        formatEnvBanner({
          service: 'payment MS',
          provider: runtime.context.providerCode,
          missing: ['PRODUCTION_FAKE_WEBHOOK_FORBIDDEN'],
          envPath,
          headline: '⚠  payment MS — fake PayPal webhook verification is forbidden in production',
        }),
      );
    }
    return new PaypalWebhookVerifier(
      runtime,
      new FakePaypalWebhookVerificationClient(),
      nodeEnv,
      envPath,
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
    return new PaypalWebhookVerifier(
      runtime,
      new FakePaypalWebhookVerificationClient(),
      nodeEnv,
      envPath,
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

  return new PaypalWebhookVerifier(
    runtime,
    new LivePaypalWebhookVerificationClient(
      oauthClient,
      {
        accountRef: runtime.context.accountRef,
        environment: runtime.context.environment,
      },
      credentials.environment,
      credentials.requestTimeoutMs ?? 10_000,
    ),
    nodeEnv,
    envPath,
  );
}
