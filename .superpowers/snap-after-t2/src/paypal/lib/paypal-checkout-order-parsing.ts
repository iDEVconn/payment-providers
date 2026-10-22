import type { CheckoutOrderStatus } from '../../contracts/index';

export type ParsedPaypalCapture = {
  id: string;
  status: string;
  amount: { currency: string; amountMinor: string } | null;
};

function majorToMinor(value: string, currency: string): string {
  const [whole = '0', fraction = ''] = value.split('.');
  const digits = currency === 'JPY' ? 0 : 2;
  const padded = fraction.padEnd(digits, '0').slice(0, digits);
  return `${whole}${padded}`.replace(/^0+(?=\d)/, '') || '0';
}

export function parsePurchaseUnitCaptures(purchaseUnits: unknown): ParsedPaypalCapture | null {
  const firstUnit = Array.isArray(purchaseUnits) ? purchaseUnits[0] : undefined;
  if (!firstUnit || typeof firstUnit !== 'object') {
    return null;
  }
  const captures =
    (
      firstUnit as {
        payments?: { captures?: Array<{ id?: string; status?: string; amount?: unknown }> };
      }
    ).payments?.captures ?? [];
  const capture = captures[0];
  if (!capture || typeof capture !== 'object' || !capture.id) {
    return null;
  }
  const amountObj = capture.amount;
  let amount: ParsedPaypalCapture['amount'] = null;
  if (amountObj && typeof amountObj === 'object') {
    const currency = (amountObj as { currency_code?: string }).currency_code;
    const value = (amountObj as { value?: string }).value;
    if (currency && value) {
      amount = { currency, amountMinor: majorToMinor(value, currency) };
    }
  }
  return {
    id: String(capture.id),
    status: String(capture.status ?? ''),
    amount,
  };
}

export function mapPaypalCaptureStatus(status: string | null | undefined): CheckoutOrderStatus {
  switch (status) {
    case 'COMPLETED':
      return 'captured';
    case 'DECLINED':
    case 'FAILED':
    case 'REFUNDED':
    case 'PARTIALLY_REFUNDED':
      return 'failed';
    case 'PENDING':
    default:
      return 'unknown';
  }
}

export function mapPaypalOrderStatus(status: string): CheckoutOrderStatus {
  switch (status) {
    case 'APPROVED':
      return 'approved';
    case 'VOIDED':
      return 'voided';
    case 'CREATED':
    case 'SAVED':
    case 'PAYER_ACTION_REQUIRED':
      return 'created';
    case 'COMPLETED':
      return 'captured';
    default:
      return 'unknown';
  }
}

export function resolveCheckoutStatusFromOrder(
  orderStatus: string,
  capture: ParsedPaypalCapture | null,
): CheckoutOrderStatus {
  if (capture?.status === 'COMPLETED') {
    return 'captured';
  }
  if (capture?.id && capture.status && capture.status !== 'COMPLETED') {
    return 'unknown';
  }
  return mapPaypalOrderStatus(orderStatus);
}

export function extractPaypalIssueCodes(body: Record<string, unknown>): string[] {
  const details = Array.isArray(body['details']) ? body['details'] : [];
  return details
    .map((detail) =>
      detail &&
      typeof detail === 'object' &&
      typeof (detail as { issue?: string }).issue === 'string'
        ? (detail as { issue: string }).issue
        : null,
    )
    .filter((issue): issue is string => issue != null);
}
