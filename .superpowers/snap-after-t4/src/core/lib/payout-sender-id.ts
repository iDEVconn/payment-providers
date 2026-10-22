import { createHash } from 'node:crypto';

/** PayPal create-payout `sender_batch_id` maximum length. */
export const PAYPAL_SENDER_BATCH_ID_MAX = 256;
/** PayPal create-payout `sender_item_id` maximum length. */
export const PAYPAL_SENDER_ITEM_ID_MAX = 63;

function maxLengthForPrefix(prefix: string): number {
  return prefix === 'item' ? PAYPAL_SENDER_ITEM_ID_MAX : PAYPAL_SENDER_BATCH_ID_MAX;
}

/** Deterministic PayPal-safe sender id derived from internal operation identity. */
export function buildPaypalSenderId(prefix: string, operationId: string): string {
  const digest = createHash('sha256').update(`${prefix}:${operationId}`).digest('hex');
  const value = `${prefix}_${digest}`;
  return value.slice(0, maxLengthForPrefix(prefix));
}
