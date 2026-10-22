import {
  sanitizePaypalTransportFailure,
  type PaypalTransportContext,
} from './paypal-transport-error';

function throwSanitizedTransportFailure(context: PaypalTransportContext, error: unknown): never {
  const sanitized = sanitizePaypalTransportFailure(context, error);
  throw Object.assign(new Error(sanitized.message), sanitized);
}
import type { PaypalOAuthHttpClient } from './paypal-oauth-client';
import type {
  PaypalOrdersHttpClient,
  PaypalOrdersHttpRequest,
  PaypalOrdersHttpResponse,
} from './paypal-orders-http-client';
import type {
  PaypalPayoutHttpClient,
  PaypalPayoutHttpRequest,
  PaypalPayoutHttpResponse,
} from './paypal-payout-http-client';
import type {
  PaypalSubscriptionHttpClient,
  PaypalSubscriptionHttpRequest,
  PaypalSubscriptionHttpResponse,
} from './paypal-subscription-http-client';
import type {
  PaypalSellerOnboardingHttpClient,
  PaypalSellerOnboardingHttpRequest,
  PaypalSellerOnboardingHttpResponse,
} from './paypal-seller-onboarding-http-client';

// Every client passes `redirect: 'error'`: PayPal APIs never redirect, and a followed redirect could
// replay the bearer token or Basic credentials to another URL. A refusal is a sanitized transport failure.

function extractDebugId(headers: Headers): string | null {
  return headers.get('paypal-debug-id') ?? headers.get('Paypal-Debug-Id');
}

async function readJsonBody(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text.slice(0, 200) };
  }
}

export class FetchPaypalOAuthHttpClient implements PaypalOAuthHttpClient {
  async postForm(
    url: string,
    body: URLSearchParams,
    headers: Record<string, string>,
    timeoutMs: number,
  ): Promise<{ status: number; body: Record<string, unknown>; debugId?: string | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        redirect: 'error',
        signal: controller.signal,
      });
      return {
        status: response.status,
        body: await readJsonBody(response),
        debugId: extractDebugId(response.headers),
      };
    } catch (error) {
      throwSanitizedTransportFailure('oauth', error);
    } finally {
      clearTimeout(timer);
    }
  }
}

export class FetchPaypalPayoutHttpClient implements PaypalPayoutHttpClient {
  constructor(private readonly defaultTimeoutMs = 10_000) {}

  async request(input: PaypalPayoutHttpRequest): Promise<PaypalPayoutHttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.defaultTimeoutMs);
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json',
      };
      if (input.requestId) {
        headers['PayPal-Request-Id'] = input.requestId;
      }
      const response = await fetch(input.path, {
        method: input.method,
        headers,
        body: input.body != null ? JSON.stringify(input.body) : undefined,
        redirect: 'error',
        signal: controller.signal,
      });
      return {
        status: response.status,
        body: await readJsonBody(response),
        debugId: extractDebugId(response.headers),
      };
    } catch (error) {
      throwSanitizedTransportFailure('payout', error);
    } finally {
      clearTimeout(timer);
    }
  }
}

export class FetchPaypalSubscriptionHttpClient implements PaypalSubscriptionHttpClient {
  constructor(private readonly defaultTimeoutMs = 10_000) {}

  async request(input: PaypalSubscriptionHttpRequest): Promise<PaypalSubscriptionHttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.defaultTimeoutMs);
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json',
      };
      if (input.requestId) {
        headers['PayPal-Request-Id'] = input.requestId;
      }
      const response = await fetch(input.path, {
        method: input.method,
        headers,
        body: input.body != null ? JSON.stringify(input.body) : undefined,
        redirect: 'error',
        signal: controller.signal,
      });
      return {
        status: response.status,
        body: await readJsonBody(response),
        debugId: extractDebugId(response.headers),
      };
    } catch (error) {
      throwSanitizedTransportFailure('subscription', error);
    } finally {
      clearTimeout(timer);
    }
  }
}

export class FetchPaypalOrdersHttpClient implements PaypalOrdersHttpClient {
  constructor(private readonly defaultTimeoutMs = 10_000) {}

  async request(input: PaypalOrdersHttpRequest): Promise<PaypalOrdersHttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.defaultTimeoutMs);
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json',
      };
      if (input.requestId) {
        headers['PayPal-Request-Id'] = input.requestId;
      }
      if (input.attributionId) {
        headers['PayPal-Partner-Attribution-Id'] = input.attributionId;
      }
      if (input.preferRepresentation) {
        headers['Prefer'] = 'return=representation';
      }
      const response = await fetch(input.path, {
        method: input.method,
        headers,
        body: input.body != null ? JSON.stringify(input.body) : undefined,
        redirect: 'error',
        signal: controller.signal,
      });
      return {
        status: response.status,
        body: await readJsonBody(response),
        debugId: extractDebugId(response.headers),
      };
    } catch (error) {
      throwSanitizedTransportFailure('orders', error);
    } finally {
      clearTimeout(timer);
    }
  }
}

export class FetchPaypalSellerOnboardingHttpClient implements PaypalSellerOnboardingHttpClient {
  constructor(private readonly defaultTimeoutMs = 10_000) {}

  async request(
    input: PaypalSellerOnboardingHttpRequest,
  ): Promise<PaypalSellerOnboardingHttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.defaultTimeoutMs);
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json',
        'PayPal-Partner-Attribution-Id': input.attributionId,
      };
      if (input.requestId) {
        headers['PayPal-Request-Id'] = input.requestId;
      }
      const response = await fetch(input.path, {
        method: input.method,
        headers,
        body: input.body != null ? JSON.stringify(input.body) : undefined,
        redirect: 'error',
        signal: controller.signal,
      });
      return {
        status: response.status,
        body: await readJsonBody(response),
        debugId: extractDebugId(response.headers),
      };
    } catch (error) {
      throwSanitizedTransportFailure('seller_onboarding', error);
    } finally {
      clearTimeout(timer);
    }
  }
}
