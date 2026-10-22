import { PaymentConfigurationError } from '../payment-configuration-error';
import type {
  CheckoutStore,
  MarketplaceStore,
  PayoutStore,
  SellerStore,
} from './payment-reliability-store';

/*
 * Feature detection for the optional store capabilities. A family is present when the store has
 * every method of it and absent when it has none; services use these guards so a
 * subscriptions-only store is enough. A family with only some of its methods (a typo, a forgotten
 * method, a partial port) is a configuration error: its events would otherwise be acknowledged as
 * `unsupported` and lost.
 */

// `acquireCheckoutCreateExecutionLease` is part of `SubscriptionStore`, so it does not mark checkout.
export const CHECKOUT_STORE_METHODS = [
  'findOperationByProviderOrderId',
  'findOperationByProviderCaptureId',
  'findOperationByProviderRefundId',
  'reserveRefundCapacity',
] as const satisfies ReadonlyArray<keyof CheckoutStore>;

export const PAYOUT_STORE_METHODS = [
  'findOperationBySenderBatchId',
  'findOperationBySenderItemId',
  'findOperationByProviderPayoutBatchId',
  'findOperationByProviderPayoutItemId',
  'listOperationsByParent',
] as const satisfies ReadonlyArray<keyof PayoutStore>;

export const SELLER_STORE_METHODS = [
  'findOperationByProviderReferralId',
  'createSellerConnection',
  'findSellerConnectionById',
  'findSellerConnectionBySellerRef',
  'findSellerConnectionByMerchantId',
  'findSellerConnectionByReferralId',
  'findSellerConnectionByTrackingId',
  'updateSellerConnection',
  'listSellerConnectionsForReconciliation',
] as const satisfies ReadonlyArray<keyof SellerStore>;

export const MARKETPLACE_STORE_METHODS = [
  'insertMarketplacePurchaseUnits',
  'listMarketplacePurchaseUnits',
  'findMarketplacePurchaseUnitById',
  'findMarketplacePurchaseUnitByReference',
  'findMarketplacePurchaseUnitByCaptureId',
  'updateMarketplacePurchaseUnit',
  'findLatestReconciliationEvidenceForResource',
] as const satisfies ReadonlyArray<keyof MarketplaceStore>;

type StoreFamily = 'checkout' | 'payout' | 'seller' | 'marketplace';

const FAMILY_METHODS: Record<StoreFamily, ReadonlyArray<string>> = {
  checkout: CHECKOUT_STORE_METHODS,
  payout: PAYOUT_STORE_METHODS,
  seller: SELLER_STORE_METHODS,
  marketplace: MARKETPLACE_STORE_METHODS,
};

/** `true` with every method, `false` with none; throws `PaymentConfigurationError` in between. */
function hasFamily(store: object, family: StoreFamily): boolean {
  const methods = FAMILY_METHODS[family];
  const missing = methods.filter(
    (method) => typeof (store as Record<string, unknown>)[method] !== 'function',
  );
  if (missing.length === 0) {
    return true;
  }
  if (missing.length === methods.length) {
    return false;
  }
  throw new PaymentConfigurationError(
    `Payment store implements only part of the ${family} capability (missing: ${missing.join(', ')}). ` +
      `Implement every method of it, or none (do not add stub methods).`,
    missing,
  );
}

/** Throws `PaymentConfigurationError` when any family is only partly implemented. */
export function assertStoreCapabilitiesComplete(
  store: object,
  families: ReadonlyArray<StoreFamily> = ['checkout', 'payout', 'seller', 'marketplace'],
): void {
  for (const family of families) {
    hasFamily(store, family);
  }
}

export function hasCheckoutStore<T extends object>(store: T): store is T & CheckoutStore {
  return hasFamily(store, 'checkout');
}

export function hasPayoutStore<T extends object>(store: T): store is T & PayoutStore {
  return hasFamily(store, 'payout');
}

export function hasSellerStore<T extends object>(store: T): store is T & SellerStore {
  return hasFamily(store, 'seller');
}

export function hasMarketplaceStore<T extends object>(store: T): store is T & MarketplaceStore {
  return hasFamily(store, 'marketplace');
}
