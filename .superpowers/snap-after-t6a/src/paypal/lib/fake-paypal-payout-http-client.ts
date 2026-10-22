import type {
  PaypalPayoutHttpClient,
  PaypalPayoutHttpRequest,
  PaypalPayoutHttpResponse,
} from './paypal-payout-http-client';

/** Test/dev boundary. Never treat as Sandbox or Live provider evidence. */
export class FakePaypalPayoutHttpClient implements PaypalPayoutHttpClient {
  async request(input: PaypalPayoutHttpRequest): Promise<PaypalPayoutHttpResponse> {
    if (input.method === 'POST' && input.path.endsWith('/payouts')) {
      const items = (input.body?.['items'] as Array<Record<string, unknown>> | undefined) ?? [];
      return {
        status: 201,
        body: {
          batch_header: {
            payout_batch_id: 'FAKE-PAYOUT-BATCH',
            batch_status: 'PENDING',
            sender_batch_header: {
              sender_batch_id: input.body?.['sender_batch_header']
                ? ((input.body['sender_batch_header'] as Record<string, unknown>)[
                    'sender_batch_id'
                  ] as string)
                : 'fake-batch',
            },
          },
          items: items.map((item, index) => ({
            payout_item_id: `FAKE-ITEM-${index + 1}`,
            payout_item: item,
            transaction_status: 'PENDING',
          })),
        },
        debugId: 'fake-debug',
      };
    }
    if (input.method === 'GET' && input.path.includes('/payouts-item/')) {
      return {
        status: 200,
        body: {
          payout_item_id: input.path.split('/').pop(),
          transaction_status: 'SUCCESS',
          payout_item_fee: { currency_code: 'USD', value: '0.25' },
          payout_item: {
            amount: { currency: 'USD', value: '10.00' },
            sender_item_id: 'fake-item',
          },
        },
        debugId: 'fake-debug',
      };
    }
    if (input.method === 'GET' && input.path.includes('/payouts/')) {
      return {
        status: 200,
        body: {
          batch_header: {
            payout_batch_id: input.path.split('/').pop(),
            batch_status: 'SUCCESS',
          },
          items: [],
        },
        debugId: 'fake-debug',
      };
    }
    if (input.method === 'POST' && input.path.includes('/cancel')) {
      return {
        status: 200,
        body: {
          payout_item_id: input.path.split('/')[input.path.split('/').length - 2],
          transaction_status: 'CANCELED',
        },
        debugId: 'fake-debug',
      };
    }
    return { status: 404, body: {}, debugId: 'fake-debug' };
  }
}
