export type PaypalWebhookVerificationHttpFailureKind =
  | 'verification_unavailable'
  | 'invalid_payload';

export class PaypalWebhookVerificationHttpError extends Error {
  readonly kind: PaypalWebhookVerificationHttpFailureKind;

  constructor(kind: PaypalWebhookVerificationHttpFailureKind, message: string) {
    super(message);
    this.name = 'PaypalWebhookVerificationHttpError';
    this.kind = kind;
  }
}

export function isRetryablePaypalVerificationHttpStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}
