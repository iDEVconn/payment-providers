import { PaymentConfigurationError } from '../../core/lib/payment-configuration-error';
import type { PaymentExecutionStatus } from '../../contracts/index';
import type { ResolvedPaymentRuntime } from '../../core/index';
import { createBlockedWebhookVerificationClient } from './blocked-provider-network';
import { shouldRejectProviderNetworkCalls } from './build-reject-only-executor';
import { FakePaypalWebhookVerificationClient } from './fake-paypal-webhook-verification-client';
import { FetchPaypalOAuthHttpClient } from './live-paypal-http-clients';
import { LivePaypalWebhookVerificationClient } from './live-paypal-webhook-verification-client';
import { PaypalOAuthClient } from './paypal-oauth-client';
import { PaypalWebhookVerifier } from './paypal-webhook-verifier';

export type BuildPaypalWebhookVerifierInput = {
  runtime: ResolvedPaymentRuntime;
  nodeEnv?: string;
  executionStatus?: PaymentExecutionStatus;
  forceFake?: boolean;
};

export function buildPaypalWebhookVerifier(
  input: BuildPaypalWebhookVerifierInput,
): PaypalWebhookVerifier {
  const { runtime, nodeEnv, forceFake, executionStatus } = input;
  const isProduction = nodeEnv === 'production';

  if (shouldRejectProviderNetworkCalls(runtime, executionStatus)) {
    return new PaypalWebhookVerifier(
      runtime,
      createBlockedWebhookVerificationClient(),
      nodeEnv,
    );
  }

  if (forceFake) {
    if (isProduction) {
      throw new PaymentConfigurationError(
        'Fake PayPal webhook verification is forbidden in production',
        ['forceFake'],
      );
    }
    return new PaypalWebhookVerifier(
      runtime,
      new FakePaypalWebhookVerificationClient(),
      nodeEnv,
    );
  }

  const credentials = runtime.checkoutCredentials;
  if (!credentials) {
    return new PaypalWebhookVerifier(
      runtime,
      createBlockedWebhookVerificationClient(),
      nodeEnv,
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
  );
}
