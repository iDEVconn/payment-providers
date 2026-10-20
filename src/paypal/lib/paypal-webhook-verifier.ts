import {
  EXECUTION_MODE_BLOCKED,
  type VerifyWebhookRequest,
  type VerifyWebhookResult,
} from '../../contracts/index';
import type { ResolvedPaymentRuntime } from '../../core/index';
import { PaypalWebhookVerificationHttpError } from './paypal-webhook-verification-http';

const WEBHOOK_VERIFICATION_PROVIDER_UNAVAILABLE =
  'Webhook verification is unavailable because payment provider access is not configured or is disabled.';

function isExecutionModeBlockedError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  return (error as { code?: unknown }).code === EXECUTION_MODE_BLOCKED;
}

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
  ) {}

  async verify(request: VerifyWebhookRequest): Promise<VerifyWebhookResult> {
    if (!request.webhookId?.trim()) {
      return {
        verified: false,
        transmissionId: request.headers.transmissionId,
        eventType: null,
        resourceId: null,
        unavailableReason: 'Webhook verification is not configured (webhook ID is missing)',
        failureKind: 'verification_unavailable',
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
        failureKind: 'invalid_payload',
      };
    }

    try {
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
        failureKind: verified ? undefined : 'signature_rejected',
      };
    } catch (error) {
      if (isExecutionModeBlockedError(error)) {
        return {
          verified: false,
          transmissionId: request.headers.transmissionId,
          eventType: parsed.event_type ?? null,
          resourceId: parsed.resource?.id ?? null,
          unavailableReason: WEBHOOK_VERIFICATION_PROVIDER_UNAVAILABLE,
          failureKind: 'verification_unavailable',
        };
      }
      if (error instanceof PaypalWebhookVerificationHttpError) {
        return {
          verified: false,
          transmissionId: request.headers.transmissionId,
          eventType: parsed.event_type ?? null,
          resourceId: parsed.resource?.id ?? null,
          unavailableReason:
            error.kind === 'verification_unavailable'
              ? 'PayPal webhook verification is temporarily unavailable'
              : 'PayPal webhook verification request was rejected',
          failureKind:
            error.kind === 'verification_unavailable'
              ? 'verification_unavailable'
              : 'invalid_payload',
        };
      }
      return {
        verified: false,
        transmissionId: request.headers.transmissionId,
        eventType: parsed.event_type ?? null,
        resourceId: parsed.resource?.id ?? null,
        unavailableReason: 'PayPal webhook verification is temporarily unavailable',
        failureKind: 'verification_unavailable',
      };
    }
  }
}
