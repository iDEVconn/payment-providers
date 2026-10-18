import type { TokenCacheScopeInput } from '../../core/index';
import type { PaypalOAuthClient } from './paypal-oauth-client';
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
      const body = (await response.json()) as { verification_status?: string };
      return { verification_status: body.verification_status ?? 'FAILURE' };
    } finally {
      clearTimeout(timer);
    }
  }
}
