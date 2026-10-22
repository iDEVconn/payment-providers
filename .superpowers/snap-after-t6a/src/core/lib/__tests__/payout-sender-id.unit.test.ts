import { describe, expect, it } from 'vitest';
import {
  buildPaypalSenderId,
  PAYPAL_SENDER_BATCH_ID_MAX,
  PAYPAL_SENDER_ITEM_ID_MAX,
} from '../payout-sender-id';

describe('buildPaypalSenderId', () => {
  it('keeps item sender ids within PayPal maximum length', () => {
    const senderItemId = buildPaypalSenderId('item', '7c305ad4-a54d-4d4c-b2f2-94a79ceb5dc7');
    expect(senderItemId.length).toBeLessThanOrEqual(PAYPAL_SENDER_ITEM_ID_MAX);
    expect(senderItemId.startsWith('item_')).toBe(true);
  });

  it('keeps batch sender ids within PayPal maximum length', () => {
    const senderBatchId = buildPaypalSenderId('batch', '68b22de3-eff5-4cc7-b442-674588809ff7');
    expect(senderBatchId.length).toBeLessThanOrEqual(PAYPAL_SENDER_BATCH_ID_MAX);
    expect(senderBatchId.startsWith('batch_')).toBe(true);
  });

  it('is deterministic for the same operation identity', () => {
    const operationId = '22c6b959-680c-44e4-a841-2cf09c2e4456';
    expect(buildPaypalSenderId('item', operationId)).toBe(buildPaypalSenderId('item', operationId));
  });
});
