import type { PaypalWebhookVerificationClient } from './paypal-webhook-verifier';

/** Test/dev boundary. Never treat this as Sandbox or Live provider evidence. */
export class FakePaypalWebhookVerificationClient implements PaypalWebhookVerificationClient {
  async verifyWebhookSignature(input: {
    transmissionSig: string;
  }): Promise<{ verification_status: string }> {
    if (input.transmissionSig === 'invalid') {
      return { verification_status: 'FAILURE' };
    }
    return { verification_status: 'SUCCESS' };
  }
}
