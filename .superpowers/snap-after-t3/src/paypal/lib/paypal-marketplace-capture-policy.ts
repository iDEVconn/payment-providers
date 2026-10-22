/** Pre-capture validation issues: no financial mutation when no capture ids are present. */
export const PAYPAL_MARKETPLACE_TERMINAL_PRE_CAPTURE_ISSUES = [
  'PLATFORM_FEES_NOT_SUPPORTED',
  'PAYEE_ACCOUNT_INVALID',
  'PAYEE_ACCOUNT_RESTRICTED',
  'PAYEE_NOT_ENABLED',
  'PAYEE_NOT_CONSENTED',
  'ORDER_NOT_APPROVED',
  'ORDER_ALREADY_CAPTURED',
  'ORDER_VOIDED',
  'INVALID_PARAMETER_SYNTAX',
  'INVALID_STRING_LENGTH',
  'MISSING_REQUIRED_PARAMETER',
] as const;

/** Per-unit or ambiguous capture issues: remain uncertain until read-only GET order. */
export const PAYPAL_MARKETPLACE_UNCERTAIN_CAPTURE_ISSUES = [
  'INSTRUMENT_DECLINED',
  'TRANSACTION_REFUSED',
  'PAYMENT_DENIED',
  'UNPROCESSABLE_ENTITY',
] as const;

export type PaypalMarketplaceCapture422Classification =
  | { kind: 'partial_with_captures' }
  | { kind: 'terminal_pre_capture'; issueCodes: string[] }
  | { kind: 'uncertain'; issueCodes: string[] };

function extractIssueCodes(body: Record<string, unknown>): string[] {
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

function bodyContainsCaptureIds(body: Record<string, unknown>): boolean {
  const purchaseUnits = Array.isArray(body['purchase_units']) ? body['purchase_units'] : [];
  for (const raw of purchaseUnits) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const payments =
      (raw as { payments?: { captures?: Array<{ id?: string }> } }).payments?.captures ?? [];
    if (payments.some((capture) => typeof capture?.id === 'string' && capture.id.length > 0)) {
      return true;
    }
  }
  return false;
}

export function classifyPaypalMarketplaceCapture422(
  body: Record<string, unknown>,
): PaypalMarketplaceCapture422Classification {
  if (bodyContainsCaptureIds(body)) {
    return { kind: 'partial_with_captures' };
  }

  const issueCodes = extractIssueCodes(body);
  if (issueCodes.length === 0) {
    return { kind: 'uncertain', issueCodes: [] };
  }

  const terminal = new Set<string>(PAYPAL_MARKETPLACE_TERMINAL_PRE_CAPTURE_ISSUES);
  const uncertain = new Set<string>(PAYPAL_MARKETPLACE_UNCERTAIN_CAPTURE_ISSUES);

  if (issueCodes.every((issue) => terminal.has(issue))) {
    return { kind: 'terminal_pre_capture', issueCodes };
  }

  if (issueCodes.some((issue) => uncertain.has(issue) || !terminal.has(issue))) {
    return { kind: 'uncertain', issueCodes };
  }

  return { kind: 'uncertain', issueCodes };
}
