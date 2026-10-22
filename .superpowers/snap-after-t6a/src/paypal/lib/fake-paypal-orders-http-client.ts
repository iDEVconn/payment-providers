import type {
  PaypalOrdersHttpClient,
  PaypalOrdersHttpRequest,
  PaypalOrdersHttpResponse,
} from './paypal-orders-http-client';

export class FakePaypalOrdersHttpClient implements PaypalOrdersHttpClient {
  async request(input: PaypalOrdersHttpRequest): Promise<PaypalOrdersHttpResponse> {
    if (input.method === 'GET' && input.path.includes('/checkout/orders/')) {
      const orderId = input.path.split('/').pop() ?? 'order-fake';
      return {
        status: 200,
        debugId: 'fake-debug-get',
        body: {
          id: orderId,
          status: 'APPROVED',
          links: [{ rel: 'approve', href: `https://sandbox.paypal.com/checkout?token=${orderId}` }],
          purchase_units: [
            {
              amount: { currency_code: 'USD', value: '9.99' },
              payments: { captures: [{ id: 'capture-fake', status: 'COMPLETED' }] },
            },
          ],
        },
      };
    }

    if (input.method === 'POST' && input.path.endsWith('/v2/checkout/orders')) {
      const orderId = 'FAKE-MKT-ORDER-1';
      return {
        status: 201,
        debugId: 'fake-debug-create',
        body: {
          id: orderId,
          status: 'CREATED',
          links: [{ rel: 'approve', href: `https://sandbox.paypal.com/checkout?token=${orderId}` }],
          purchase_units: Array.isArray(
            (input.body as { purchase_units?: unknown[] })?.purchase_units,
          )
            ? ((
                input.body as { purchase_units: Array<Record<string, unknown>> }
              ).purchase_units.map((unit, index) => ({
                reference_id: unit['reference_id'] ?? `REF-${index + 1}`,
                payee: unit['payee'],
                amount: unit['amount'],
                payment_instruction: unit['payment_instruction'],
              })) as unknown[])
            : [],
        },
      };
    }

    if (input.method === 'POST' && input.path.includes('/capture')) {
      const orderId = input.path.split('/').slice(-2)[0] ?? 'order-fake';
      return {
        status: 201,
        debugId: 'fake-debug-capture',
        body: {
          id: orderId,
          status: 'COMPLETED',
          purchase_units: [
            {
              reference_id: 'REF-1',
              payments: {
                captures: [
                  {
                    id: 'capture-fake-1',
                    status: 'COMPLETED',
                    amount: { currency_code: 'USD', value: '10.00' },
                    seller_receivable_breakdown: {
                      gross_amount: { currency_code: 'USD', value: '10.00' },
                      paypal_fee: { currency_code: 'USD', value: '0.59' },
                      net_amount: { currency_code: 'USD', value: '9.41' },
                    },
                  },
                ],
              },
            },
          ],
        },
      };
    }

    if (input.method === 'POST' && input.path.includes('/refund')) {
      return {
        status: 201,
        debugId: 'fake-debug-refund',
        body: {
          id: 'refund-fake',
          status: 'COMPLETED',
          amount: { currency_code: 'USD', value: '9.99' },
        },
      };
    }

    return { status: 404, body: { name: 'RESOURCE_NOT_FOUND' }, debugId: 'fake-debug-404' };
  }
}
