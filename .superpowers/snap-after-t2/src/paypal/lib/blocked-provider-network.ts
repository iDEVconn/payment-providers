import { EXECUTION_MODE_BLOCKED } from '../../contracts/index';
import type { PaypalWebhookVerificationClient } from './paypal-webhook-verifier';

const blockedError = {
  code: EXECUTION_MODE_BLOCKED,
  message: 'Provider network calls are blocked for the resolved execution mode',
  retryable: false,
  uncertain: false,
};

export function createBlockedOAuthClient(): () => Promise<string> {
  return async () => {
    throw blockedError;
  };
}

export function createBlockedHttpClient<T>(): T {
  return new Proxy(
    {},
    {
      get() {
        return async () => {
          throw blockedError;
        };
      },
    },
  ) as T;
}

export function createBlockedWebhookVerificationClient(): PaypalWebhookVerificationClient {
  return {
    async verifyWebhookSignature() {
      throw blockedError;
    },
  };
}
