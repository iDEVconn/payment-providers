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
    /** Original webhook body text; live clients send it to PayPal unmodified (#15). */
    rawWebhookEvent?: string;
  }): Promise<{ verification_status: string }>;
};

export type PaypalWebhookVerifierOptions = {
  /** Webhook id used when a request carries none (checked when the verifier is built). */
  webhookId?: string;
};

type ParsedWebhookEvent = { event_type?: string; resource?: { id?: string } };

function isJsonObject(value: unknown): value is ParsedWebhookEvent {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class PaypalWebhookVerifier {
  constructor(
    private readonly runtime: ResolvedPaymentRuntime,
    private readonly client: PaypalWebhookVerificationClient,
    private readonly nodeEnv: string | undefined,
    private readonly options: PaypalWebhookVerifierOptions = {},
  ) {}

  async verify(request: VerifyWebhookRequest): Promise<VerifyWebhookResult> {
    const webhookId = request.webhookId?.trim() || this.options.webhookId?.trim();
    if (!webhookId) {
      return {
        verified: false,
        transmissionId: request.headers.transmissionId,
        eventType: null,
        resourceId: null,
        unavailableReason: 'Webhook verification is not configured (webhook ID is missing)',
        failureKind: 'verification_unavailable',
      };
    }

    let parsed: ParsedWebhookEvent;
    try {
      const value: unknown = JSON.parse(request.rawBody);
      if (!isJsonObject(value)) {
        throw new Error('not an object');
      }
      parsed = value;
    } catch {
      return {
        verified: false,
        transmissionId: request.headers.transmissionId,
        eventType: null,
        resourceId: null,
        unavailableReason: 'Webhook body is not a valid JSON object',
        failureKind: 'invalid_payload',
      };
    }

    try {
      const response = await this.client.verifyWebhookSignature({
        webhookId,
        transmissionId: request.headers.transmissionId,
        transmissionTime: request.headers.transmissionTime,
        certUrl: request.headers.certUrl,
        authAlgo: request.headers.authAlgo,
        transmissionSig: request.headers.transmissionSig,
        webhookEvent: parsed,
        rawWebhookEvent: request.rawBody,
      });

      // Only an explicit FAILURE is a rejected signature; anything else we cannot read stays retryable.
      const status = response.verification_status;
      if (status !== 'SUCCESS' && status !== 'FAILURE') {
        return {
          verified: false,
          transmissionId: request.headers.transmissionId,
          eventType: parsed.event_type ?? null,
          resourceId: parsed.resource?.id ?? null,
          unavailableReason: 'PayPal webhook verification is temporarily unavailable',
          failureKind: 'verification_unavailable',
        };
      }
      const verified = status === 'SUCCESS';
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
