import type { TokenCacheScopeInput } from '../../core/index';
import type { PaypalOAuthClient } from './paypal-oauth-client';
import {
  isRetryablePaypalVerificationHttpStatus,
  PaypalWebhookVerificationHttpError,
} from './paypal-webhook-verification-http';
import type { PaypalWebhookVerificationClient } from './paypal-webhook-verifier';

export class LivePaypalWebhookVerificationClient implements PaypalWebhookVerificationClient {
  constructor(
    private readonly oauthClient: PaypalOAuthClient,
    private readonly scope: TokenCacheScopeInput,
    private readonly environment: 'sandbox' | 'live',
    private readonly timeoutMs: number,
  ) {}

  async verifyWebhookSignature(input: {
    webhookId: string;
    transmissionId: string;
    transmissionTime: string;
    certUrl: string;
    authAlgo: string;
    transmissionSig: string;
    webhookEvent: unknown;
  }): Promise<{ verification_status: string }> {
    const token = await this.oauthClient.getAccessToken(this.scope);
    const baseUrl =
      this.environment === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${baseUrl}/v1/notifications/verify-webhook-signature`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          auth_algo: input.authAlgo,
          cert_url: input.certUrl,
          transmission_id: input.transmissionId,
          transmission_sig: input.transmissionSig,
          transmission_time: input.transmissionTime,
          webhook_id: input.webhookId,
          webhook_event: input.webhookEvent,
        }),
        signal: controller.signal,
      });
      const responseText = await response.text();
      if (!response.ok) {
        if (isRetryablePaypalVerificationHttpStatus(response.status)) {
          throw new PaypalWebhookVerificationHttpError(
            'verification_unavailable',
            `PayPal webhook verification HTTP ${response.status}`,
          );
        }
        throw new PaypalWebhookVerificationHttpError(
          'invalid_payload',
          `PayPal webhook verification HTTP ${response.status}`,
        );
      }
      let body: { verification_status?: string };
      try {
        body = JSON.parse(responseText) as { verification_status?: string };
      } catch {
        throw new PaypalWebhookVerificationHttpError(
          'invalid_payload',
          'PayPal webhook verification response is not valid JSON',
        );
      }
      if (typeof body.verification_status !== 'string') {
        throw new PaypalWebhookVerificationHttpError(
          'invalid_payload',
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
      throw new PaypalWebhookVerificationHttpError(
        'verification_unavailable',
        'PayPal webhook verification failed due to a network error',
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
