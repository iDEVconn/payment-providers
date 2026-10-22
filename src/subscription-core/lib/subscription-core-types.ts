import type { CanonicalMoney } from '../../contracts/lib/money';
import type { SubscriptionStatus } from '../../contracts/lib/subscription';

/** Money in integer minor units as a decimal string, same shape as `CanonicalMoney`. */
export type SubscriptionMoney = CanonicalMoney;

export type SubscriptionLastPayment = {
  amountMinor: string;
  currency: string;
  /** ISO timestamp of the payment, null when the provider did not send one. */
  time: string | null;
};

/** Sale data of a `PAYMENT.SALE.*` event. `amountMinor` is null when the amount cannot be represented. */
export type SubscriptionSalePayment = {
  amountMinor: string | null;
  currency: string | null;
  saleId: string | null;
};

export type SubscriptionEventResourceType = 'subscription' | 'sale';

/** Event type the core uses for a provider lookup (GET subscription), never sent by PayPal. */
export const SUBSCRIPTION_LOOKUP_EVENT_TYPE = 'paypal.subscription.lookup';

export type NormalizedSubscriptionEvent = {
  /** Webhook body `id`; null for a provider lookup snapshot. */
  providerEventId: string | null;
  eventType: string;
  resourceType: SubscriptionEventResourceType;
  /** Subscription events: `resource.id`; sale events: `resource.billing_agreement_id`. */
  providerSubscriptionId: string;
  providerPlanId: string | null;
  /** Raw `resource.status` (subscription resources only). */
  providerStatus: string | null;
  /** Status this event implies (event type first, then `resource.status`); null when it implies none. */
  subscriptionStatus: SubscriptionStatus | null;
  /** ISO `resource.update_time ?? resource.create_time`; null when absent or invalid. */
  stateAt: string | null;
  nextBillingTime: string | null;
  startTime: string | null;
  lastPayment: SubscriptionLastPayment | null;
  failedPaymentsCount: number | null;
  outstandingBalance: SubscriptionMoney | null;
  /** Present for `PAYMENT.SALE.*` events only. */
  payment: SubscriptionSalePayment | null;
  /** ISO body `create_time`. */
  eventTime: string | null;
};

export type NormalizeSubscriptionEventFailureReason =
  | 'invalid_json'
  | 'not_an_object'
  | 'missing_event_id'
  | 'missing_event_type'
  | 'unsupported_event_type'
  | 'missing_resource'
  | 'missing_subscription_id';

export type NormalizeSubscriptionEventResult =
  | { ok: true; event: NormalizedSubscriptionEvent }
  | { ok: false; reason: NormalizeSubscriptionEventFailureReason };

/** The subscription fields a host persists and feeds back into `reduceSubscription`. */
export type SubscriptionState = {
  status: SubscriptionStatus;
  /** When set, events for another subscription id are ignored. */
  providerSubscriptionId: string | null;
  providerPlanId: string | null;
  /** Provider state watermark (ISO). Only status-bearing webhook events advance it. */
  stateAt: string | null;
  nextBillingTime: string | null;
  startTime: string | null;
  lastPayment: SubscriptionLastPayment | null;
  /** Never lowered, except when the provider resets it (re-activation or a newer last payment). */
  failedPaymentsCount: number | null;
  lastEventId: string | null;
  /** Last `SUBSCRIPTION_RECENT_ID_LIMIT` applied webhook ids; a repeat is a `duplicate_event` noop. */
  recentEventIds: string[];
  /** Last `SUBSCRIPTION_RECENT_ID_LIMIT` completed sale ids; a repeat is a `duplicate_event` noop. */
  recentSaleIds: string[];
};

/** How many recent webhook ids and sale ids `SubscriptionState` keeps for redelivery dedupe. */
export const SUBSCRIPTION_RECENT_ID_LIMIT = 16;

export type ReduceSubscriptionOptions = {
  /**
   * Expected plan; defaults to the stored `providerPlanId`. A mismatch blocks
   * only moves to (or staying in) `approved`/`active`; cancellations,
   * suspensions, expiries and failed payments still apply and report
   * `plan_mismatch`. Pass the new plan here to adopt it (plan revision).
   */
  expectedPlanId?: string | null;
  /** Expected price of one billing cycle; a sale below it or in another currency is reported, not applied. */
  expectedPayment?: SubscriptionMoney | null;
  /** `lookup` is a provider GET: authoritative over event ordering, still bound by the transition rules. */
  source: 'webhook' | 'lookup';
};

export type SubscriptionEffect =
  | { type: 'status_changed'; from: SubscriptionStatus; to: SubscriptionStatus }
  | {
      type: 'payment_completed';
      amountMinor: string;
      currency: string;
      saleId: string | null;
      time: string | null;
    }
  | {
      type: 'payment_failed';
      failedPaymentsCount: number;
      outstandingBalance: SubscriptionMoney | null;
    }
  | { type: 'plan_mismatch'; expectedPlanId: string; actualPlanId: string }
  | {
      type: 'amount_mismatch';
      /** Null when no price was expected but the sale amount could not be read. */
      expected: SubscriptionMoney | null;
      actual: { amountMinor: string | null; currency: string | null };
      saleId: string | null;
    }
  | {
      type: 'currency_mismatch';
      expectedCurrency: string;
      actualCurrency: string | null;
      saleId: string | null;
    }
  | {
      type: 'refund_or_reversal';
      eventType: string;
      amountMinor: string | null;
      currency: string | null;
      saleId: string | null;
    }
  | { type: 'period_updated'; nextBillingTime: string | null; startTime: string | null };

export type SubscriptionEffectType = SubscriptionEffect['type'];

export type ReduceSubscriptionNoopReason =
  | 'duplicate_event'
  | 'subscription_mismatch'
  | 'plan_mismatch'
  | 'amount_mismatch'
  | 'currency_mismatch'
  | 'stale'
  | 'equal_conflict'
  | 'missing_timestamp'
  | 'transition_rejected'
  | 'unsupported_event_type';

export type ReduceSubscriptionResult =
  | { state: SubscriptionState; decision: 'applied'; reason?: undefined; effects: SubscriptionEffect[] }
  | {
      state: SubscriptionState;
      decision: 'noop';
      reason: ReduceSubscriptionNoopReason;
      effects: SubscriptionEffect[];
    };
