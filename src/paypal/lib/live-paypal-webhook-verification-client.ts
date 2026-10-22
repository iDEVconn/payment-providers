import { PAYMENT_RELIABILITY_ERROR } from '../../contracts/index';
import type { TokenCacheScopeInput } from '../../core/index';
import { sendWithPaypalAccessToken } from './paypal-access-token-retry';
import type { PaypalOAuthClient } from './paypal-oauth-client';
import { PaypalWebhookVerificationHttpError } from './paypal-webhook-verification-http';
import type { PaypalWebhookVerificationClient } from './paypal-webhook-verifier';

type VerifyWebhookSignatureInput = Parameters<
  PaypalWebhookVerificationClient['verifyWebhookSignature']
>[0];

/**
 * Builds the verify-webhook-signature body. PayPal checks the signature against the event exactly as
 * delivered, so `webhook_event` is the original raw text spliced in, never a re-serialisation (which
 * can change escaped unicode, number formatting or key order). The raw text must parse as one JSON
 * object, so the splice cannot add or override outer fields.
 */
function buildVerifyRequestBody(input: VerifyWebhookSignatureInput): string {
  const fields = {
    auth_algo: input.authAlgo,
    cert_url: input.certUrl,
    transmission_id: input.transmissionId,
    transmission_sig: input.transmissionSig,
    transmission_time: input.transmissionTime,
    webhook_id: input.webhookId,
  };
  if (input.rawWebhookEvent === undefined) {
    return JSON.stringify({ ...fields, webhook_event: input.webhookEvent });
  }

  let event: unknown;
  try {
    event = JSON.parse(input.rawWebhookEvent);
  } catch {
    event = null;
  }
  if (typeof event !== 'object' || event === null || Array.isArray(event)) {
    throw new PaypalWebhookVerificationHttpError(
      'invalid_payload',
      'Webhook body is not a valid JSON object',
    );
  }
  // `JSON.stringify` drops undefined fields; with none left the envelope is `{}` and needs no comma.
  const envelope = JSON.stringify(fields);
  const head = envelope === '{}' ? '{' : `${envelope.slice(0, -1)},`;
  return `${head}"webhook_event":${input.rawWebhookEvent}}`;
}

function isProviderAuthFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === PAYMENT_RELIABILITY_ERROR.PROVIDER_AUTH_FAILURE
  );
}

export class LivePaypalWebhookVerificationClient implements PaypalWebhookVerificationClient {
  constructor(
    private readonly oauthClient: PaypalOAuthClient,
    private readonly scope: TokenCacheScopeInput,
    private readonly environment: 'sandbox' | 'live',
    private readonly timeoutMs: number,
  ) {}

  async verifyWebhookSignature(
    input: VerifyWebhookSignatureInput,
  ): Promise<{ verification_status: string }> {
    const requestBody = buildVerifyRequestBody(input);
    const baseUrl =
      this.environment === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
    try {
      const response = await sendWithPaypalAccessToken(
        (_scope, options) => this.oauthClient.getAccessToken(this.scope, options),
        this.scope,
        (token) =>
          this.post(`${baseUrl}/v1/notifications/verify-webhook-signature`, token, requestBody),
      );
      // Any non-2xx (401/403 after the token retry, 400, 5xx) is our or PayPal's failure, not a
      // signature verdict: keep the evidence pending so a redelivery or recovery can verify it.
      if (!response.ok) {
        throw new PaypalWebhookVerificationHttpError(
          'verification_unavailable',
          `PayPal webhook verification HTTP ${response.status}`,
        );
      }
      let body: { verification_status?: unknown };
      try {
        body = JSON.parse(response.text) as { verification_status?: unknown };
      } catch {
        throw new PaypalWebhookVerificationHttpError(
          'verification_unavailable',
          'PayPal webhook verification response is not valid JSON',
        );
      }
      if (typeof body?.verification_status !== 'string') {
        throw new PaypalWebhookVerificationHttpError(
          'verification_unavailable',
          'PayPal webhook verification response missing verification_status',
        );
      }
      return { verification_status: body.verification_status };
    } catch (error) {
      if (error instanceof PaypalWebhookVerificationHttpError) {
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new PaypalWebhookVerificationHttpError(
          'verification_unavailable',
          'PayPal webhook verification timed out',
        );
      }
      if (isProviderAuthFailure(error)) {
        throw new PaypalWebhookVerificationHttpError(
          'verification_unavailable',
          'PayPal webhook verification could not authenticate',
        );
      }
      throw new PaypalWebhookVerificationHttpError(
        'verification_unavailable',
        'PayPal webhook verification failed due to a network error',
      );
    }
  }

  private async post(
    url: string,
    token: string,
    body: string,
  ): Promise<{ status: number; ok: boolean; text: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body,
        redirect: 'error',
        signal: controller.signal,
      });
      return { status: response.status, ok: response.ok, text: await response.text() };
    } finally {
      clearTimeout(timer);
    }
  }
}
