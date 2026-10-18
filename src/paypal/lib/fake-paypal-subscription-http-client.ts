import type {
  PaypalSubscriptionHttpClient,
  PaypalSubscriptionHttpRequest,
  PaypalSubscriptionHttpResponse,
} from './paypal-subscription-http-client';

/** Test/dev boundary. Never treat as Sandbox or Live provider evidence. */
export class FakePaypalSubscriptionHttpClient implements PaypalSubscriptionHttpClient {
  async request(input: PaypalSubscriptionHttpRequest): Promise<PaypalSubscriptionHttpResponse> {
    if (input.method === 'POST' && input.path.endsWith('/products')) {
      return {
        status: 201,
        body: { id: 'FAKE-PROD-1', name: 'Fake Product', type: 'SERVICE' },
        debugId: 'fake-debug',
      };
    }
    if (input.method === 'GET' && input.path.includes('/products/')) {
      return {
        status: 200,
        body: {
          id: input.path.split('/').pop(),
          name: 'Fake Product',
          type: 'SERVICE',
        },
        debugId: 'fake-debug',
      };
    }
    if (input.method === 'POST' && input.path.endsWith('/plans')) {
      return {
        status: 201,
        body: {
          id: 'FAKE-PLAN-1',
          product_id: 'FAKE-PROD-1',
          status: 'CREATED',
          name: 'Fake Plan',
        },
        debugId: 'fake-debug',
      };
    }
    if (
      input.method === 'GET' &&
      input.path.includes('/plans/') &&
      !input.path.includes('/activate')
    ) {
      return {
        status: 200,
        body: {
          id: input.path.split('/').pop(),
          product_id: 'FAKE-PROD-1',
          status: 'ACTIVE',
          name: 'Fake Plan',
        },
        debugId: 'fake-debug',
      };
    }
    if (
      input.method === 'POST' &&
      (input.path.includes('/activate') || input.path.includes('/deactivate'))
    ) {
      return {
        status: 204,
        body: {},
        debugId: 'fake-debug',
      };
    }
    if (input.method === 'POST' && input.path.endsWith('/subscriptions')) {
      return {
        status: 201,
        body: {
          id: 'FAKE-SUB-1',
          plan_id: 'FAKE-PLAN-1',
          status: 'APPROVAL_PENDING',
          links: [{ rel: 'approve', href: 'https://example.test/approve' }],
        },
        debugId: 'fake-debug',
      };
    }
    if (input.method === 'GET' && input.path.includes('/subscriptions/')) {
      return {
        status: 200,
        body: {
          id: input.path.split('/').pop(),
          plan_id: 'FAKE-PLAN-1',
          status: 'ACTIVE',
          billing_info: { next_billing_time: '2026-10-24T00:00:00Z' },
        },
        debugId: 'fake-debug',
      };
    }
    if (
      input.method === 'POST' &&
      (input.path.includes('/cancel') ||
        input.path.includes('/suspend') ||
        input.path.includes('/activate'))
    ) {
      const status = input.path.includes('/cancel')
        ? 'CANCELLED'
        : input.path.includes('/suspend')
          ? 'SUSPENDED'
          : 'ACTIVE';
      return {
        status: 200,
        body: { id: 'FAKE-SUB-1', status },
        debugId: 'fake-debug',
      };
    }
    return { status: 404, body: {}, debugId: 'fake-debug' };
  }
}
