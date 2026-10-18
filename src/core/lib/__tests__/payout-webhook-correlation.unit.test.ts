import { describe, expect, it } from 'vitest';
import { buildOperationIdempotencyScope } from '../operation-idempotency';
import { majorUnitsToMinorString } from '../money';
import { MemoryPaymentReliabilityStore } from '../persistence/memory-payment-reliability-store';
import {
  correlatePayoutOperation,
  isPaypalWebhookEnvelopeId,
  parsePaypalPayoutWebhookPayload,
  validatePayoutEvidenceMatch,
} from '../payout-webhook-correlation';

describe('payout-webhook-correlation', () => {
  it('converts PayPal major units to minor units without floating-point math', () => {
    expect(majorUnitsToMinorString('3.92', 'USD')).toBe('392');
    expect(majorUnitsToMinorString('0.08', 'USD')).toBe('8');
  });

  it('detects PayPal webhook envelope ids', () => {
    expect(isPaypalWebhookEnvelopeId('WH-ABC123')).toBe(true);
    expect(isPaypalWebhookEnvelopeId('QJBZAQ9NCX6X4')).toBe(false);
  });

  it('parses batch and item payout webhook payloads', () => {
    const batch = parsePaypalPayoutWebhookPayload(
      JSON.stringify({
        resource: {
          id: 'WH-BATCH',
          batch_header: {
            payout_batch_id: 'QJBZAQ9NCX6X4',
            sender_batch_header: { sender_batch_id: 'batch_sender_1' },
          },
        },
      }),
      'PAYMENT.PAYOUTSBATCH.PROCESSING',
    );
    expect(batch?.providerPayoutBatchId).toBe('QJBZAQ9NCX6X4');
    expect(batch?.senderBatchId).toBe('batch_sender_1');

    const item = parsePaypalPayoutWebhookPayload(
      JSON.stringify({
        resource: {
          id: 'WH-ITEM',
          payout_batch_id: 'QJBZAQ9NCX6X4',
          payout_item_id: 'L6V2ER6KKB4CS',
          sender_item_id: 'sender_item_1',
          payout_item: {
            amount: { currency: 'USD', value: '3.92' },
            receiver: 'creator@example.com',
          },
          payout_item_fee: { currency: 'USD', value: '0.08' },
        },
      }),
      'PAYMENT.PAYOUTS-ITEM.UNCLAIMED',
    );
    expect(item?.providerPayoutItemId).toBe('L6V2ER6KKB4CS');
    expect(item?.amountMinor).toBe('392');
    expect(item?.providerFeeMinor).toBe('8');
    expect(item?.recipientValue).toBe('creator@example.com');
  });

  it('correlates batch webhooks by provider batch id', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const batch = await store.createOperation({
      idempotencyKey: 'batch-1',
      idempotencyScope: buildOperationIdempotencyScope({
        applicationRef: 'edc',
        accountRef: 'default',
        environment: 'sandbox',
        kind: 'payout_batch',
      }),
      commandFingerprint: 'fp',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'edc',
      environment: 'sandbox',
      kind: 'payout_batch',
      providerPayoutBatchId: 'QJBZAQ9NCX6X4',
      senderBatchId: 'batch_sender_1',
    });

    const correlation = await correlatePayoutOperation(store, {
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'edc',
      environment: 'sandbox',
      eventType: 'PAYMENT.PAYOUTSBATCH.SUCCESS',
      resourceId: 'WH-BATCH',
      rawPayload: JSON.stringify({
        resource: {
          id: 'WH-BATCH',
          batch_header: {
            payout_batch_id: 'QJBZAQ9NCX6X4',
            sender_batch_header: { sender_batch_id: 'batch_sender_1' },
          },
        },
      }),
    });

    expect(correlation?.operation.operationId).toBe(batch.operationId);
    expect(correlation?.matchKind).toBe('primary');
  });

  it('parses nested payout_item.sender_item_id from real UNCLAIMED webhook shape', () => {
    const parsed = parsePaypalPayoutWebhookPayload(
      JSON.stringify({
        resource: {
          id: 'WH-UNCLAIMED',
          payout_batch_id: 'QJBZAQ9NCX6X4',
          payout_item_id: 'L6V2ER6KKB4CS',
          payout_item: {
            amount: { currency: 'USD', value: '3.92' },
            receiver: 'sb-meoca52812488@personal.example.com',
            recipient_type: 'EMAIL',
            sender_item_id: 'item_eebcb6051d0c758f42b1ce5ec8f032a26635e0b4b04f950b356a8b2586',
            recipient_wallet: 'PAYPAL',
          },
          payout_item_fee: { currency: 'USD', value: '0.08' },
        },
      }),
      'PAYMENT.PAYOUTS-ITEM.UNCLAIMED',
    );

    expect(parsed?.senderItemId).toBe(
      'item_eebcb6051d0c758f42b1ce5ec8f032a26635e0b4b04f950b356a8b2586',
    );
    expect(parsed?.providerPayoutItemId).toBe('L6V2ER6KKB4CS');
    expect(parsed?.providerPayoutBatchId).toBe('QJBZAQ9NCX6X4');
    expect(parsed?.amountMinor).toBe('392');
    expect(parsed?.providerFeeMinor).toBe('8');
    expect(parsed?.recipientValue).toBe('sb-meoca52812488@personal.example.com');
  });

  it('correlates UNCLAIMED item webhooks when sender_item_id is only nested under payout_item', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const batch = await store.createOperation({
      idempotencyKey: 'batch-hosted',
      idempotencyScope: buildOperationIdempotencyScope({
        applicationRef: 'edc',
        accountRef: 'default',
        environment: 'sandbox',
        kind: 'payout_batch',
      }),
      commandFingerprint: 'fp',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'edc',
      environment: 'sandbox',
      kind: 'payout_batch',
      providerPayoutBatchId: 'QJBZAQ9NCX6X4',
      senderBatchId: 'batch_c860752dd1960bbdeacfbafef3c2c2ae78a08a6c024714905faabfdb96bc4b8d',
    });
    const item = await store.createOperation({
      idempotencyKey: 'item-hosted',
      idempotencyScope: buildOperationIdempotencyScope({
        applicationRef: 'edc',
        accountRef: 'default',
        environment: 'sandbox',
        kind: 'payout_item',
      }),
      commandFingerprint: 'fp-item',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'edc',
      environment: 'sandbox',
      kind: 'payout_item',
      parentOperationId: batch.operationId,
      senderItemId: 'item_eebcb6051d0c758f42b1ce5ec8f032a26635e0b4b04f950b356a8b2586',
      amountMinor: '392',
      currencyCode: 'USD',
      recipientValue: 'sb-meoca52812488@personal.example.com',
    });

    const correlation = await correlatePayoutOperation(store, {
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'edc',
      environment: 'sandbox',
      eventType: 'PAYMENT.PAYOUTS-ITEM.UNCLAIMED',
      resourceId: 'WH-UNCLAIMED',
      rawPayload: JSON.stringify({
        resource: {
          id: 'WH-UNCLAIMED',
          payout_batch_id: 'QJBZAQ9NCX6X4',
          payout_item_id: 'L6V2ER6KKB4CS',
          payout_item: {
            amount: { currency: 'USD', value: '3.92' },
            receiver: 'sb-meoca52812488@personal.example.com',
            sender_item_id: 'item_eebcb6051d0c758f42b1ce5ec8f032a26635e0b4b04f950b356a8b2586',
          },
          payout_item_fee: { currency: 'USD', value: '0.08' },
        },
      }),
    });

    expect(correlation?.operation.operationId).toBe(item.operationId);
    expect(correlation?.matchKind).toBe('fallback');
  });

  it('correlates item webhooks by sender item id fallback with validation', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const batch = await store.createOperation({
      idempotencyKey: 'batch-2',
      idempotencyScope: buildOperationIdempotencyScope({
        applicationRef: 'edc',
        accountRef: 'default',
        environment: 'sandbox',
        kind: 'payout_batch',
      }),
      commandFingerprint: 'fp',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'edc',
      environment: 'sandbox',
      kind: 'payout_batch',
      providerPayoutBatchId: 'QJBZAQ9NCX6X4',
    });
    const item = await store.createOperation({
      idempotencyKey: 'item-1',
      idempotencyScope: buildOperationIdempotencyScope({
        applicationRef: 'edc',
        accountRef: 'default',
        environment: 'sandbox',
        kind: 'payout_item',
      }),
      commandFingerprint: 'fp-item',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'edc',
      environment: 'sandbox',
      kind: 'payout_item',
      parentOperationId: batch.operationId,
      senderItemId: 'sender_item_1',
      amountMinor: '392',
      currencyCode: 'USD',
      recipientValue: 'creator@example.com',
    });

    const correlation = await correlatePayoutOperation(store, {
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'edc',
      environment: 'sandbox',
      eventType: 'PAYMENT.PAYOUTS-ITEM.UNCLAIMED',
      resourceId: 'WH-ITEM',
      rawPayload: JSON.stringify({
        resource: {
          id: 'WH-ITEM',
          payout_batch_id: 'QJBZAQ9NCX6X4',
          payout_item_id: 'L6V2ER6KKB4CS',
          sender_item_id: 'sender_item_1',
          payout_item: {
            amount: { currency: 'USD', value: '3.92' },
            receiver: 'creator@example.com',
          },
        },
      }),
    });

    expect(correlation?.operation.operationId).toBe(item.operationId);
    expect(correlation?.matchKind).toBe('fallback');
  });

  it('rejects fallback correlation when amount or recipient mismatch', async () => {
    const store = new MemoryPaymentReliabilityStore();
    await store.createOperation({
      idempotencyKey: 'item-bad',
      idempotencyScope: buildOperationIdempotencyScope({
        applicationRef: 'edc',
        accountRef: 'default',
        environment: 'sandbox',
        kind: 'payout_item',
      }),
      commandFingerprint: 'fp-item',
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'edc',
      environment: 'sandbox',
      kind: 'payout_item',
      senderItemId: 'sender_item_1',
      amountMinor: '500',
      currencyCode: 'USD',
      recipientValue: 'other@example.com',
    });

    const parsed = parsePaypalPayoutWebhookPayload(
      JSON.stringify({
        resource: {
          sender_item_id: 'sender_item_1',
          payout_item: {
            amount: { currency: 'USD', value: '3.92' },
            receiver: 'creator@example.com',
          },
        },
      }),
      'PAYMENT.PAYOUTS-ITEM.UNCLAIMED',
    );
    const operation = await store.findOperationBySenderItemId(
      'paypal',
      'default',
      'sandbox',
      'sender_item_1',
    );
    if (!operation || !parsed) {
      throw new Error('expected operation and parsed payload');
    }
    expect(
      await validatePayoutEvidenceMatch(store, operation, parsed, {
        applicationRef: 'edc',
      }),
    ).toBe(false);
  });
});
