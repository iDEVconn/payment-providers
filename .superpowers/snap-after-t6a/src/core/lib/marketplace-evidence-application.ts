import type {
  ExecuteMarketplaceUnitSnapshot,
  MarketplaceOrderStatus,
  MarketplacePurchaseUnitRecord,
  MarketplaceUnitStatus,
} from '../../contracts/index';
import {
  deriveMarketplaceOrderStatusFromUnits,
  mapPaypalOrderStatusToMarketplace,
} from './marketplace-transition-policy';
import type { MarketplaceStore } from './persistence/payment-reliability-store';

function mapCaptureStatus(status: string | undefined): MarketplaceUnitStatus {
  switch (status) {
    case 'COMPLETED':
      return 'captured';
    case 'DECLINED':
    case 'FAILED':
      return 'declined';
    case 'PENDING':
      return 'unknown';
    default:
      return 'unknown';
  }
}

export function parsePurchaseUnitsFromOrderBody(
  body: Record<string, unknown>,
  knownReferences: Map<string, { providerMerchantId: string | null }>,
): ExecuteMarketplaceUnitSnapshot[] {
  const purchaseUnits = Array.isArray(body['purchase_units']) ? body['purchase_units'] : [];
  return purchaseUnits.map((raw) => {
    const unit = raw as Record<string, unknown>;
    const referenceId = String(unit['reference_id'] ?? 'default');
    const payee =
      unit['payee'] && typeof unit['payee'] === 'object'
        ? (unit['payee'] as { merchant_id?: string })
        : undefined;
    const amountObj = unit['amount'] as { currency_code?: string; value?: string } | undefined;
    const captures =
      unit['payments'] && typeof unit['payments'] === 'object'
        ? (
            unit['payments'] as {
              captures?: Array<Record<string, unknown>>;
            }
          ).captures
        : undefined;
    const capture = captures?.[0];
    const breakdown =
      capture?.['seller_receivable_breakdown'] &&
      typeof capture['seller_receivable_breakdown'] === 'object'
        ? (capture['seller_receivable_breakdown'] as Record<string, unknown>)
        : undefined;
    const paypalFee = breakdown?.['paypal_fee'] as
      | { currency_code?: string; value?: string }
      | undefined;
    const netAmount = breakdown?.['net_amount'] as
      | { currency_code?: string; value?: string }
      | undefined;
    const platformFees =
      unit['payment_instruction'] && typeof unit['payment_instruction'] === 'object'
        ? (
            unit['payment_instruction'] as {
              platform_fees?: Array<{ amount?: { currency_code?: string; value?: string } }>;
            }
          ).platform_fees
        : undefined;
    const platformFeeAmount = platformFees?.[0]?.amount;

    const amount =
      amountObj?.currency_code && amountObj.value
        ? {
            currency: amountObj.currency_code,
            amountMinor: majorToMinor(amountObj.value, amountObj.currency_code),
          }
        : { currency: 'USD', amountMinor: '0' };

    return {
      referenceId,
      providerMerchantId:
        payee?.merchant_id ?? knownReferences.get(referenceId)?.providerMerchantId ?? '',
      amount,
      platformFee:
        platformFeeAmount?.currency_code && platformFeeAmount.value
          ? {
              currency: platformFeeAmount.currency_code,
              amountMinor: majorToMinor(platformFeeAmount.value, platformFeeAmount.currency_code),
            }
          : null,
      unitStatus: mapCaptureStatus(
        typeof capture?.['status'] === 'string' ? capture['status'] : undefined,
      ),
      providerCaptureId: typeof capture?.['id'] === 'string' ? capture['id'] : null,
      providerFee:
        paypalFee?.currency_code && paypalFee.value
          ? {
              currency: paypalFee.currency_code,
              amountMinor: majorToMinor(paypalFee.value, paypalFee.currency_code),
            }
          : null,
      netAmount:
        netAmount?.currency_code && netAmount.value
          ? {
              currency: netAmount.currency_code,
              amountMinor: majorToMinor(netAmount.value, netAmount.currency_code),
            }
          : null,
    };
  });
}

function majorToMinor(value: string, currency: string): string {
  const [whole = '0', fraction = ''] = value.split('.');
  const digits = currency === 'JPY' ? 0 : 2;
  const padded = fraction.padEnd(digits, '0').slice(0, digits);
  return `${whole}${padded}`.replace(/^0+(?=\d)/, '') || '0';
}

export async function applyMarketplaceUnitSnapshots(input: {
  store: MarketplaceStore;
  operationId: string;
  snapshots: ExecuteMarketplaceUnitSnapshot[];
  preserveCaptured: boolean;
}): Promise<MarketplacePurchaseUnitRecord[]> {
  const existing = await input.store.listMarketplacePurchaseUnits(input.operationId);
  const byReference = new Map(existing.map((unit) => [unit.referenceId, unit]));
  const updated: MarketplacePurchaseUnitRecord[] = [];

  for (const snapshot of input.snapshots) {
    const current = byReference.get(snapshot.referenceId);
    if (!current) {
      continue;
    }
    if (
      input.preserveCaptured &&
      current.unitStatus === 'captured' &&
      snapshot.unitStatus !== 'captured'
    ) {
      updated.push(current);
      continue;
    }
    const next = await input.store.updateMarketplacePurchaseUnit({
      unitId: current.unitId,
      expectedVersion: current.version,
      unitStatus: snapshot.unitStatus,
      providerCaptureId: snapshot.providerCaptureId ?? current.providerCaptureId,
      providerFeeMinor: snapshot.providerFee?.amountMinor ?? current.providerFeeMinor,
      providerFeeCurrency: snapshot.providerFee?.currency ?? current.providerFeeCurrency,
      netAmountMinor: snapshot.netAmount?.amountMinor ?? current.netAmountMinor,
    });
    updated.push(next);
  }

  return updated;
}

export function resolveMarketplaceStatusFromOrder(
  orderStatus: string,
  units: MarketplaceUnitStatus[],
): MarketplaceOrderStatus {
  const fromUnits = deriveMarketplaceOrderStatusFromUnits(units);
  const fromOrder = mapPaypalOrderStatusToMarketplace(orderStatus);
  if (fromOrder === 'partially_captured') {
    return 'partially_captured';
  }
  if (fromUnits === 'captured' || fromUnits === 'partially_captured') {
    return fromUnits;
  }
  return fromOrder;
}
