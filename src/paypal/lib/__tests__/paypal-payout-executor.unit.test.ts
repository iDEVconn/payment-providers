import { describe, expect, it } from 'vitest';
import { evaluateCapabilities, type ResolvedPaymentRuntime } from '../../../core/index';
import { FakePaypalPayoutHttpClient } from '../fake-paypal-payout-http-client';
import { PaypalPayoutExecutor } from '../paypal-payout-executor';

function runtime(enabled: boolean): ResolvedPaymentRuntime {
  const context = {
    providerCode: 'paypal',
    accountRef: 'default',
    applicationRef: 'edc',
    environment: 'sandbox' as const,
  };
  return {
    mode: 'live-provider',
    context,
    descriptor: {
      ...context,
      capabilities: evaluateCapabilities((key) => {
        if (key === 'PAYPAL_CLIENT_ID' || key === 'PAYPAL_CLIENT_SECRET') return 'set';
        if (key === 'PAYPAL_PAYOUTS_ENABLED') return enabled ? 'true' : undefined;
        return undefined;
      }, context),
    },
    checkoutCredentials: {
      clientId: 'id',
      clientSecret: 'secret',
      environment: 'sandbox',
    },
  };
}

describe('PaypalPayoutExecutor', () => {
  it('accepts a payout batch without marking items succeeded', async () => {
    const executor = new PaypalPayoutExecutor(
      runtime(true),
      new FakePaypalPayoutHttpClient(),
      async () => 'token',
    );
    const result = await executor.submitBatch({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'edc',
      environment: 'sandbox',
      providerRequestId: 'req-1',
      senderBatchId: 'batch-1',
      items: [
        {
          senderItemId: 'item-1',
          amount: { currency: 'USD', amountMinor: '1000' },
          recipientType: 'EMAIL',
          receiver: 'payee@example.com',
        },
      ],
    });

    expect(result.batchPayoutStatus).toBe('accepted');
    expect(result.items[0]?.payoutStatus).toBe('pending');
    expect(result.providerPayoutBatchId).toBe('FAKE-PAYOUT-BATCH');
  });

  it('rejects payout execution when capability is disabled', async () => {
    const executor = new PaypalPayoutExecutor(
      runtime(false),
      new FakePaypalPayoutHttpClient(),
      async () => 'token',
    );
    await expect(
      executor.submitBatch({
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'edc',
        environment: 'sandbox',
        providerRequestId: 'req-1',
        senderBatchId: 'batch-1',
        items: [
          {
            senderItemId: 'item-1',
            amount: { currency: 'USD', amountMinor: '1000' },
            recipientType: 'EMAIL',
            receiver: 'payee@example.com',
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
  });

  it('returns read-only batch and item lookups', async () => {
    const executor = new PaypalPayoutExecutor(
      runtime(true),
      new FakePaypalPayoutHttpClient(),
      async () => 'token',
    );
    const batch = await executor.getBatch({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'edc',
      environment: 'sandbox',
      providerPayoutBatchId: 'batch-lookup',
    });
    expect(batch.batchPayoutStatus).toBe('processing');

    const item = await executor.getItem({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'edc',
      environment: 'sandbox',
      providerPayoutItemId: 'item-lookup',
    });
    expect(item.payoutStatus).toBe('succeeded');
    expect(item.amount).toEqual({ currency: 'USD', amountMinor: '1000' });
    expect(item.providerFee).toEqual({ currency: 'USD', amountMinor: '25' });
  });

  it('parses the live Payouts GET amount shape without floating-point math', async () => {
    const executor = new PaypalPayoutExecutor(
      runtime(true),
      {
        async request() {
          return {
            status: 200,
            body: {
              payout_item_id: 'L6V2ER6KKB4CS',
              payout_batch_id: 'QJBZAQ9NCX6X4',
              transaction_status: 'RETURNED',
              payout_item: {
                sender_item_id: 'item-1',
                amount: { value: '3.92', currency: 'USD' },
              },
              payout_item_fee: { currency_code: 'USD', value: '0.08' },
            },
            debugId: 'debug-returned',
          };
        },
      },
      async () => 'token',
    );

    const item = await executor.getItem({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'edc',
      environment: 'sandbox',
      providerPayoutItemId: 'L6V2ER6KKB4CS',
    });

    expect(item.amount).toEqual({ currency: 'USD', amountMinor: '392' });
    expect(item.providerFee).toEqual({ currency: 'USD', amountMinor: '8' });
    expect(item.payoutStatus).toBe('returned');
  });

  it('rejects conflicting PayPal amount currency fields fail-closed', async () => {
    const executor = new PaypalPayoutExecutor(
      runtime(true),
      {
        async request() {
          return {
            status: 200,
            body: {
              payout_item_id: 'L6V2ER6KKB4CS',
              transaction_status: 'SUCCESS',
              payout_item: {
                amount: { value: '3.92', currency: 'USD', currency_code: 'EUR' },
              },
            },
          };
        },
      },
      async () => 'token',
    );

    await expect(
      executor.getItem({
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'edc',
        environment: 'sandbox',
        providerPayoutItemId: 'L6V2ER6KKB4CS',
      }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_VALIDATION_REJECTION',
      message: 'PayPal payout amount has conflicting currency fields',
    });
  });

  it('sends a PayPal wallet item and PayPal-Request-Id', async () => {
    const requests: Array<{ requestId?: string; body?: Record<string, unknown> }> = [];
    const executor = new PaypalPayoutExecutor(
      runtime(true),
      {
        async request(input) {
          requests.push({ requestId: input.requestId, body: input.body });
          return new FakePaypalPayoutHttpClient().request(input);
        },
      },
      async () => 'token',
    );
    await executor.submitBatch({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'edc',
      environment: 'sandbox',
      providerRequestId: 'req-stable',
      senderBatchId: 'batch-1',
      items: [
        {
          senderItemId: 'item-1',
          amount: { currency: 'USD', amountMinor: '200' },
          recipientType: 'EMAIL',
          receiver: 'payee@example.com',
        },
      ],
    });
    expect(requests[0]?.requestId).toBe('req-stable');
    const item = (requests[0]?.body?.['items'] as Array<Record<string, unknown>>)[0];
    expect(item?.['recipient_wallet']).toBe('PAYPAL');
    expect((item?.['amount'] as { value: string }).value).toBe('2.00');
  });

  it('rejects overlong sender ids before any HTTP call', async () => {
    const httpClient = new FakePaypalPayoutHttpClient();
    const executor = new PaypalPayoutExecutor(runtime(true), httpClient, async () => 'token');
    await expect(
      executor.submitBatch({
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'edc',
        environment: 'sandbox',
        providerRequestId: 'req-1',
        senderBatchId: 'b'.repeat(300),
        items: [
          {
            senderItemId: 'i'.repeat(80),
            amount: { currency: 'USD', amountMinor: '200' },
            recipientType: 'EMAIL',
            receiver: 'payee@example.com',
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_VALIDATION_REJECTION',
      message: expect.stringContaining('sender_batch_id exceeds PayPal maximum length'),
    });
  });

  it('includes PayPal issue codes in terminal 400 rejection messages', async () => {
    const executor = new PaypalPayoutExecutor(
      runtime(true),
      {
        async request() {
          return {
            status: 400,
            body: {
              name: 'VALIDATION_ERROR',
              details: [{ issue: 'INVALID_CURRENCY_CODE' }],
            },
            debugId: 'debug-400',
          };
        },
      },
      async () => 'token',
    );
    await expect(
      executor.submitBatch({
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'edc',
        environment: 'sandbox',
        providerRequestId: 'req-1',
        senderBatchId: 'batch-1',
        items: [
          {
            senderItemId: 'item-1',
            amount: { currency: 'USD', amountMinor: '200' },
            recipientType: 'EMAIL',
            receiver: 'payee@example.com',
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_TERMINAL_REJECTION',
      message: 'PayPal rejected the payout batch request: INVALID_CURRENCY_CODE',
      providerDebugId: 'debug-400',
    });
  });

  it('reconciles a duplicate sender batch instead of rejecting it', async () => {
    const paths: string[] = [];
    const executor = new PaypalPayoutExecutor(
      runtime(true),
      {
        async request(input) {
          paths.push(`${input.method} ${input.path}`);
          if (input.method === 'POST') {
            return {
              status: 400,
              body: {
                name: 'USER_BUSINESS_ERROR',
                details: [
                  {
                    field: 'SENDER_BATCH_ID',
                    issue: 'Batch with given sender_batch_id already exists',
                    link: [
                      {
                        href: 'https://api-m.sandbox.paypal.com/v1/payments/payouts/EXISTING-BATCH',
                        rel: 'self',
                      },
                    ],
                  },
                ],
              },
              debugId: 'dup',
            };
          }
          return {
            status: 200,
            body: {
              batch_header: {
                payout_batch_id: 'EXISTING-BATCH',
                batch_status: 'PENDING',
              },
              items: [
                {
                  payout_item_id: 'EXISTING-ITEM',
                  transaction_status: 'PENDING',
                  payout_item: { sender_item_id: 'item-1' },
                },
              ],
            },
            debugId: 'get',
          };
        },
      },
      async () => 'token',
    );
    const result = await executor.submitBatch({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'edc',
      environment: 'sandbox',
      providerRequestId: 'req-1',
      senderBatchId: 'batch-1',
      items: [
        {
          senderItemId: 'item-1',
          amount: { currency: 'USD', amountMinor: '200' },
          recipientType: 'EMAIL',
          receiver: 'payee@example.com',
        },
      ],
    });
    expect(paths.some((path) => path.includes('/v1/payments/payouts/EXISTING-BATCH'))).toBe(true);
    expect(result.providerPayoutBatchId).toBe('EXISTING-BATCH');
    expect(result.batchPayoutStatus).toBe('accepted');
    expect(result.items[0]?.payoutStatus).toBe('pending');
  });
});
