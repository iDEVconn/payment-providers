import { formatEnvBanner, missingEnv } from '../../core/lib/host-env-banner';
import type { VerifyWebhookRequest, VerifyWebhookResult } from '../../contracts/index';
import type { ResolvedPaymentRuntime } from '../../core/index';

export type PaypalWebhookVerificationClient = {
  verifyWebhookSignature(input: {
    webhookId: string;
    transmissionId: string;
    transmissionTime: string;
    certUrl: string;
    authAlgo: string;
    transmissionSig: string;
    webhookEvent: unknown;
  }): Promise<{ verification_status: string }>;
};

export class PaypalWebhookVerifier {
  constructor(
    private readonly runtime: ResolvedPaymentRuntime,
    private readonly client: PaypalWebhookVerificationClient,
    private readonly nodeEnv: string | undefined,
    private readonly envPath: string,
  ) {}

  async verify(request: VerifyWebhookRequest): Promise<VerifyWebhookResult> {
    const missing = missingEnv(
      (key) => (key === 'PAYPAL_WEBHOOK_ID' ? request.webhookId : undefined),
      ['PAYPAL_WEBHOOK_ID'],
    );
    if (missing.length > 0) {
      const banner = formatEnvBanner({
        service: 'payment MS',
        provider: request.providerCode,
        missing,
        envPath: this.envPath,
        headline: `⚠  payment MS — webhook verification unavailable (missing PAYPAL_WEBHOOK_ID)`,
      });
      if (this.nodeEnv === 'production') {
        throw new Error(banner);
      }
      return {
        verified: false,
        transmissionId: request.headers.transmissionId,
        eventType: null,
        resourceId: null,
        unavailableReason: 'Webhook verification is not configured',
      };
    }

    let parsed: { event_type?: string; resource?: { id?: string } };
    try {
      parsed = JSON.parse(request.rawBody) as { event_type?: string; resource?: { id?: string } };
    } catch {
      return {
        verified: false,
        transmissionId: request.headers.transmissionId,
        eventType: null,
        resourceId: null,
        unavailableReason: 'Webhook body is not valid JSON',
      };
    }

    const response = await this.client.verifyWebhookSignature({
      webhookId: request.webhookId,
      transmissionId: request.headers.transmissionId,
      transmissionTime: request.headers.transmissionTime,
      certUrl: request.headers.certUrl,
      authAlgo: request.headers.authAlgo,
      transmissionSig: request.headers.transmissionSig,
      webhookEvent: parsed,
    });

    const verified = response.verification_status === 'SUCCESS';
    return {
      verified,
      transmissionId: request.headers.transmissionId,
      eventType: parsed.event_type ?? null,
      resourceId: parsed.resource?.id ?? null,
      unavailableReason: verified ? undefined : 'PayPal rejected webhook signature',
    };
  }
}
