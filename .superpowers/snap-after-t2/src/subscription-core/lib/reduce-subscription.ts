import {
  SUBSCRIPTION_RECENT_ID_LIMIT,
  type NormalizedSubscriptionEvent,
  type ReduceSubscriptionNoopReason,
  type ReduceSubscriptionOptions,
  type ReduceSubscriptionResult,
  type SubscriptionEffect,
  type SubscriptionLastPayment,
  type SubscriptionMoney,
  type SubscriptionState,
} from './subscription-core-types';
import { compareMinorUnits, isMinorUnitString, normalizeCurrencyCode } from './subscription-money';
import {
  SUBSCRIPTION_PAYMENT_FAILED_EVENT_TYPE,
  compareProviderStateTimestamps,
  evaluateSubscriptionStateOrdering,
  resolveSubscriptionStatusTransition,
} from './subscription-status-rules';

export type {
  ReduceSubscriptionOptions,
  ReduceSubscriptionResult,
  SubscriptionState,
} from './subscription-core-types';

/** Events that re-activate a subscription; PayPal resets its failed-payment counter on them. */
const ACTIVATION_EVENT_TYPES: ReadonlySet<string> = new Set([
  'BILLING.SUBSCRIPTION.ACTIVATED',
  'BILLING.SUBSCRIPTION.RE-ACTIVATED',
]);

export function initialSubscriptionState(overrides: Partial<SubscriptionState> = {}): SubscriptionState {
  return cloneState({
    status: 'approval_pending',
    providerSubscriptionId: null,
    providerPlanId: null,
    stateAt: null,
    nextBillingTime: null,
    startTime: null,
    lastPayment: null,
    failedPaymentsCount: null,
    lastEventId: null,
    recentEventIds: [],
    recentSaleIds: [],
    ...overrides,
  });
}

function copyMoney(money: SubscriptionMoney | null): SubscriptionMoney | null {
  return money ? { amountMinor: money.amountMinor, currency: money.currency } : null;
}

function copyLastPayment(payment: SubscriptionLastPayment | null): SubscriptionLastPayment | null {
  return payment ? { amountMinor: payment.amountMinor, currency: payment.currency, time: payment.time } : null;
}

/** A copy that shares no object with the input (also fills lists missing on older host rows). */
function cloneState(state: SubscriptionState): SubscriptionState {
  return {
    ...state,
    lastPayment: copyLastPayment(state.lastPayment),
    recentEventIds: [...(state.recentEventIds ?? [])],
    recentSaleIds: [...(state.recentSaleIds ?? [])],
  };
}

function remember(list: readonly string[] | undefined, id: string | null): string[] {
  const current = [...(list ?? [])];
  if (id === null || current.includes(id)) {
    return current;
  }
  return [...current, id].slice(-SUBSCRIPTION_RECENT_ID_LIMIT);
}

function noop(
  state: SubscriptionState,
  reason: ReduceSubscriptionNoopReason,
  effects: SubscriptionEffect[] = [],
): ReduceSubscriptionResult {
  return { state: cloneState(state), decision: 'noop', reason, effects };
}

/** Apply `next` and record the event (ids for dedupe, the learned subscription id). */
function applied(
  state: SubscriptionState,
  event: NormalizedSubscriptionEvent,
  next: Partial<SubscriptionState>,
  effects: SubscriptionEffect[],
  saleId: string | null = null,
): ReduceSubscriptionResult {
  return {
    state: cloneState({
      ...state,
      ...next,
      providerSubscriptionId: state.providerSubscriptionId ?? event.providerSubscriptionId,
      lastEventId: event.providerEventId ?? state.lastEventId,
      recentEventIds: remember(state.recentEventIds, event.providerEventId),
      recentSaleIds: remember(state.recentSaleIds, saleId),
    }),
    decision: 'applied',
    effects,
  };
}

/** True when `candidate` is not older than `current` (null times never win over a known time). */
function isNotOlder(candidate: string | null, current: string | null): boolean {
  if (!current) {
    return true;
  }
  if (!candidate) {
    return false;
  }
  return compareProviderStateTimestamps(current, candidate) !== 'older';
}

function isNewer(candidate: string | null, current: string | null): boolean {
  if (!candidate) {
    return false;
  }
  return !current || compareProviderStateTimestamps(current, candidate) === 'newer';
}

function isDuplicate(state: SubscriptionState, event: NormalizedSubscriptionEvent): boolean {
  const eventId = event.providerEventId;
  if (eventId !== null && (eventId === state.lastEventId || (state.recentEventIds ?? []).includes(eventId))) {
    return true;
  }
  const saleId = event.eventType === 'PAYMENT.SALE.COMPLETED' ? (event.payment?.saleId ?? null) : null;
  return saleId !== null && (state.recentSaleIds ?? []).includes(saleId);
}

function reduceSale(
  state: SubscriptionState,
  event: NormalizedSubscriptionEvent,
  options: ReduceSubscriptionOptions,
): ReduceSubscriptionResult {
  const payment = event.payment ?? { amountMinor: null, currency: null, saleId: null };

  if (event.eventType !== 'PAYMENT.SALE.COMPLETED') {
    return applied(state, event, {}, [
      {
        type: 'refund_or_reversal',
        eventType: event.eventType,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        saleId: payment.saleId,
      },
    ]);
  }

  const expected = options.expectedPayment ?? null;
  const expectedCurrency = expected ? normalizeCurrencyCode(expected.currency) : null;
  if (expectedCurrency && payment.currency !== expectedCurrency) {
    return noop(state, 'currency_mismatch', [
      {
        type: 'currency_mismatch',
        expectedCurrency,
        actualCurrency: payment.currency,
        saleId: payment.saleId,
      },
    ]);
  }
  // A malformed expected price fails closed, as does an amount that cannot be represented.
  if (
    payment.amountMinor === null ||
    payment.currency === null ||
    (expected !== null &&
      (!expectedCurrency ||
        !isMinorUnitString(expected.amountMinor) ||
        compareMinorUnits(payment.amountMinor, expected.amountMinor) < 0))
  ) {
    const expectedMoney: SubscriptionMoney | null = expected
      ? { amountMinor: expected.amountMinor, currency: expectedCurrency ?? expected.currency }
      : null;
    return noop(state, 'amount_mismatch', [
      {
        type: 'amount_mismatch',
        expected: expectedMoney,
        actual: { amountMinor: payment.amountMinor, currency: payment.currency },
        saleId: payment.saleId,
      },
    ]);
  }

  const time = event.stateAt ?? event.eventTime;
  const lastPayment = isNotOlder(time, state.lastPayment?.time ?? null)
    ? { amountMinor: payment.amountMinor, currency: payment.currency, time }
    : state.lastPayment;
  return applied(
    state,
    event,
    { lastPayment },
    [
      {
        type: 'payment_completed',
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        saleId: payment.saleId,
        time,
      },
    ],
    payment.saleId,
  );
}

function reducePaymentFailed(
  state: SubscriptionState,
  event: NormalizedSubscriptionEvent,
  planEffects: SubscriptionEffect[],
): ReduceSubscriptionResult {
  const stored = state.failedPaymentsCount ?? 0;
  // PayPal's counter only grows between successful payments; an out-of-order event never lowers it.
  const failedPaymentsCount =
    event.failedPaymentsCount !== null ? Math.max(stored, event.failedPaymentsCount) : stored + 1;
  return applied(state, event, { failedPaymentsCount }, [
    ...planEffects,
    {
      type: 'payment_failed',
      failedPaymentsCount,
      outstandingBalance: copyMoney(event.outstandingBalance),
    },
  ]);
}

function resolveFailedPaymentsCount(
  state: SubscriptionState,
  event: NormalizedSubscriptionEvent,
): number | null {
  const incoming = event.failedPaymentsCount;
  if (incoming === null) {
    return state.failedPaymentsCount;
  }
  // The provider resets the counter on re-activation and after a successful payment.
  const providerReset =
    ACTIVATION_EVENT_TYPES.has(event.eventType) ||
    isNewer(event.lastPayment?.time ?? null, state.lastPayment?.time ?? null);
  if (providerReset || state.failedPaymentsCount === null) {
    return incoming;
  }
  return Math.max(state.failedPaymentsCount, incoming);
}

function reduceSubscriptionResource(
  state: SubscriptionState,
  event: NormalizedSubscriptionEvent,
  options: ReduceSubscriptionOptions,
  planEffects: SubscriptionEffect[],
): ReduceSubscriptionResult {
  const desired =
    event.subscriptionStatus && event.subscriptionStatus !== 'unknown'
      ? event.subscriptionStatus
      : state.status;
  const resolved = resolveSubscriptionStatusTransition(state.status, desired);
  const isLookup = options.source === 'lookup';

  // A plan mismatch blocks granting or keeping access; it never blocks losing it.
  if (planEffects.length > 0 && (resolved === 'approved' || resolved === 'active')) {
    return noop(state, 'plan_mismatch', planEffects);
  }

  const ordering = evaluateSubscriptionStateOrdering({
    currentStatus: state.status,
    storedStateAt: state.stateAt,
    desiredStatus: resolved,
    incomingStateAt: event.stateAt,
    authoritative: isLookup,
  });
  if (ordering.action === 'noop') {
    return noop(state, ordering.reason);
  }
  if (resolved !== desired) {
    return noop(state, 'transition_rejected');
  }

  // A lookup never moves the watermark back; a webhook moves it to its own time.
  const stateAt = isLookup
    ? event.stateAt && isNotOlder(event.stateAt, state.stateAt)
      ? event.stateAt
      : state.stateAt
    : (ordering.stateAt ?? state.stateAt);

  const nextBillingTime = event.nextBillingTime ?? state.nextBillingTime;
  const startTime = event.startTime ?? state.startTime;
  const lastPayment =
    event.lastPayment && isNotOlder(event.lastPayment.time, state.lastPayment?.time ?? null)
      ? event.lastPayment
      : state.lastPayment;

  const effects: SubscriptionEffect[] = [...planEffects];
  if (resolved !== state.status) {
    effects.push({ type: 'status_changed', from: state.status, to: resolved });
  }
  if (nextBillingTime !== state.nextBillingTime || startTime !== state.startTime) {
    effects.push({ type: 'period_updated', nextBillingTime, startTime });
  }
  return applied(
    state,
    event,
    {
      status: resolved,
      // A mismatching plan is reported, never adopted; the host adopts it via `expectedPlanId`.
      providerPlanId: planEffects.length > 0 ? state.providerPlanId : (event.providerPlanId ?? state.providerPlanId),
      stateAt,
      nextBillingTime,
      startTime,
      lastPayment,
      failedPaymentsCount: resolveFailedPaymentsCount(state, event),
    },
    effects,
  );
}

/**
 * Pure subscription reducer: given the stored state and one normalised event,
 * return the next state, whether the event applied, and plain-data effects the
 * host maps to its own business hooks. Never mutates its inputs, and the
 * returned state and effects share no objects with the inputs (a noop returns
 * an equal copy of `state`).
 *
 * Rules: terminal `cancelled|expired` never move; nothing past approval moves
 * back to `approval_pending`, and `active|suspended` never move back to
 * `approved`; for webhooks an older `stateAt` is a noop, an equal `stateAt`
 * with a conflicting status is a noop, and a missing `stateAt` after a
 * watermark is a noop; a `lookup` is authoritative over ordering.
 *
 * Plan check: `expectedPlanId` defaults to the stored `providerPlanId`. An
 * event plan id that differs reports `plan_mismatch`; it blocks the event only
 * when the result would be `approved`/`active` (access), while suspensions,
 * cancellations, expiries and failed payments still apply. A mismatching plan
 * is never stored; pass the new plan as `expectedPlanId` to adopt it.
 *
 * Money: a completed sale in another currency or below `expectedPayment` is
 * reported and not applied. Payment events never change the status or the
 * watermark. `failedPaymentsCount` never decreases, except when the provider
 * resets it (an activation event, or a resource with a newer last payment).
 *
 * Dedupe: a webhook id among the last `SUBSCRIPTION_RECENT_ID_LIMIT` applied
 * ids, or a completed sale id among the recent sale ids, is a `duplicate_event`
 * noop. This is a safety net only: hosts must dedupe on the provider event id
 * (and the sale id for payments) before calling the reducer.
 */
export function reduceSubscription(
  state: SubscriptionState,
  event: NormalizedSubscriptionEvent,
  options: ReduceSubscriptionOptions,
): ReduceSubscriptionResult {
  if (isDuplicate(state, event)) {
    return noop(state, 'duplicate_event');
  }
  if (state.providerSubscriptionId && event.providerSubscriptionId !== state.providerSubscriptionId) {
    return noop(state, 'subscription_mismatch');
  }

  const expectedPlanId = options.expectedPlanId ?? state.providerPlanId;
  const planEffects: SubscriptionEffect[] =
    expectedPlanId && event.providerPlanId && event.providerPlanId !== expectedPlanId
      ? [{ type: 'plan_mismatch', expectedPlanId, actualPlanId: event.providerPlanId }]
      : [];

  if (event.resourceType === 'sale') {
    return reduceSale(state, event, options);
  }
  if (event.eventType === SUBSCRIPTION_PAYMENT_FAILED_EVENT_TYPE) {
    return reducePaymentFailed(state, event, planEffects);
  }
  return reduceSubscriptionResource(state, event, options, planEffects);
}
