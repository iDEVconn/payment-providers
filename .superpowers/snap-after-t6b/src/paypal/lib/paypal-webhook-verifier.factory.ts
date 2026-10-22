import { PaymentConfigurationError } from '../../core/lib/payment-configuration-error';
import type { PaymentExecutionStatus } from '../../contracts/index';
import type { ResolvedPaymentRuntime } from '../../core/index';
import { createBlockedWebhookVerificationClient } from './blocked-provider-network';
import {
  assertProviderNetworkAllowedInProduction,
  shouldRejectProviderNetworkCalls,
} from './build-reject-only-executor';
import { FakePaypalWebhookVerificationClient } from './fake-paypal-webhook-verification-client';
import { FetchPaypalOAuthHttpClient } from './live-paypal-http-clients';
import { LivePaypalWebhookVerificationClient } from './live-paypal-webhook-verification-client';
import { PaypalOAuthClient } from './paypal-oauth-client';
import { PaypalWebhookVerifier } from './paypal-webhook-verifier';

export type BuildPaypalWebhookVerifierInput = {
  runtime: ResolvedPaymentRuntime;
  nodeEnv?: string;
  executionStatus?: PaymentExecutionStatus;
  /** See `resolvePaymentRuntime`: build a reject-only composition in production on purpose. */
  allowRejectOnlyInProduction?: boolean;
  forceFake?: boolean;
  /** PayPal webhook id (`PAYPAL_WEBHOOK_ID`); used when a verify request carries none. */
  webhookId?: string;
  /**
   * Throw when the verifier is built without `webhookId`, instead of answering every request with
   * `verification_unavailable`. Defaults to true when `nodeEnv === 'production'` and the verifier
   * would call PayPal (not for a kill switch or an intentional reject-only composition).
   */
  requireWebhookId?: boolean;
};

export function buildPaypalWebhookVerifier(
  input: BuildPaypalWebhookVerifierInput,
): PaypalWebhookVerifier {
  const { runtime, nodeEnv, forceFake, executionStatus } = input;
  const isProduction = nodeEnv === 'production';
  const webhookId = input.webhookId?.trim() || undefined;
  const options = { webhookId };

  assertProviderNetworkAllowedInProduction({
    runtime,
    executionStatus,
    nodeEnv,
    component: 'PayPal webhook verifier',
    allowRejectOnlyInProduction: input.allowRejectOnlyInProduction,
    allowKillSwitch: true,
  });
  // A blocked verifier (kill switch, intentional reject-only) never reaches PayPal, so the id is only
  // required by default when production verification would actually call PayPal.
  const requireWebhookId =
    input.requireWebhookId ??
    (isProduction && !shouldRejectProviderNetworkCalls(runtime, executionStatus));
  if (requireWebhookId && !webhookId) {
    throw new PaymentConfigurationError(
      'PayPal webhook verification requires a webhook id (PAYPAL_WEBHOOK_ID)',
      ['webhookId'],
    );
  }

  if (shouldRejectProviderNetworkCalls(runtime, executionStatus)) {
    return new PaypalWebhookVerifier(
      runtime,
      createBlockedWebhookVerificationClient(),
      nodeEnv,
      options,
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
      options,
    );
  }

  const credentials = runtime.checkoutCredentials;
  if (!credentials) {
    return new PaypalWebhookVerifier(
      runtime,
      createBlockedWebhookVerificationClient(),
      nodeEnv,
      options,
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
    options,
  );
}
