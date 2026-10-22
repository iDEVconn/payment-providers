import { describe, expect, it } from 'vitest';
import {
  initialSubscriptionState,
  reduceSubscription,
  type ReduceSubscriptionOptions,
  type ReduceSubscriptionResult,
  type SubscriptionState,
} from '../reduce-subscription';
import {
  normalizePaypalSubscriptionEvent,
  normalizePaypalSubscriptionResource,
} from '../normalize-paypal-subscription-event';
import type { NormalizedSubscriptionEvent } from '../subscription-core-types';

/*
 * Table-driven vectors. Each vector starts from a stored state, feeds a
 * sequence of raw PayPal bodies through normalise -> reduce exactly as a host
 * would, and checks the final state and every step's decision. Scenarios come
 * from issue #2 (event ordering), issue #4 (billing data, money and plan
 * checks) and the plan's review focus (missing and equal timestamps, money
 * shapes, hostile bodies).
 */

let seq = 0;
type RawResource = Record<string, unknown>;

function webhook(eventType: string, resource: RawResource, extra: Record<string, unknown> = {}): string {
  seq += 1;
  return JSON.stringify({ id: `WH-${seq}`, event_type: eventType, ...extra, resource });
}

/** Same body with a fixed webhook id, to model a PayPal redelivery. */
function withId(raw: string, id: string): string {
  return JSON.stringify({ ...(JSON.parse(raw) as Record<string, unknown>), id });
}

function sub(eventSuffix: string, ts?: string, resource: RawResource = {}): string {
  return webhook(`BILLING.SUBSCRIPTION.${eventSuffix}`, {
    id: 'I-SUB',
    ...(ts ? { update_time: ts, create_time: ts } : {}),
    ...resource,
  });
}

function sale(
  eventSuffix: 'COMPLETED' | 'REFUNDED' | 'REVERSED',
  total: unknown,
  currency: unknown,
  extra: RawResource = {},
): string {
  return webhook(`PAYMENT.SALE.${eventSuffix}`, {
    id: `SALE-${seq + 1}`,
    billing_agreement_id: 'I-SUB',
    amount: { total, currency },
    create_time: '2026-10-22T10:00:00Z',
    ...extra,
  });
}

function lookup(status: string, ts?: string, resource: RawResource = {}): string {
  return JSON.stringify({
    id: 'I-SUB',
    status,
    plan_id: 'P-1',
    ...(ts ? { update_time: ts } : {}),
    ...resource,
  });
}

type Step = {
  raw: string;
  source?: 'webhook' | 'lookup';
  options?: Omit<ReduceSubscriptionOptions, 'source'>;
  decision: 'applied' | 'noop';
  reason?: string;
  effects?: string[];
};

type Vector = {
  name: string;
  start?: Partial<SubscriptionState>;
  steps: Step[];
  expectState: Partial<SubscriptionState>;
};

const T0 = '2026-10-22T10:00:00Z';
const T1 = '2026-10-22T11:00:00Z';
const T2 = '2026-10-22T12:00:00Z';
const T3 = '2026-10-22T13:00:00Z';
const iso = (t: string) => new Date(Date.parse(t)).toISOString();
const PRICE = { amountMinor: '999', currency: 'USD' };

function normalize(step: Step): NormalizedSubscriptionEvent {
  const result =
    step.source === 'lookup'
      ? normalizePaypalSubscriptionResource(step.raw)
      : normalizePaypalSubscriptionEvent(step.raw);
  if (!result.ok) {
    throw new Error(`vector body did not normalise: ${result.reason}`);
  }
  return result.event;
}

const vectors: Vector[] = [
  // ---- Issue #2: ordering --------------------------------------------------
  {
    name: '#2a no timestamps: late CREATED after ACTIVATED stays active',
    steps: [
      { raw: sub('ACTIVATED'), decision: 'applied', effects: ['status_changed'] },
      { raw: sub('CREATED'), decision: 'noop', reason: 'transition_rejected' },
    ],
    expectState: { status: 'active', stateAt: null },
  },
  {
    name: '#2a with update_time: late CREATED (older) after ACTIVATED stays active',
    steps: [
      { raw: sub('ACTIVATED', T1), decision: 'applied', effects: ['status_changed'] },
      { raw: sub('CREATED', T0), decision: 'noop', reason: 'stale' },
    ],
    expectState: { status: 'active', stateAt: iso(T1) },
  },
  {
    name: '#2a late CREATED with a NEWER timestamp still never regresses to approval_pending',
    steps: [
      { raw: sub('ACTIVATED', T0), decision: 'applied' },
      { raw: sub('CREATED', T1), decision: 'noop', reason: 'transition_rejected' },
    ],
    expectState: { status: 'active', stateAt: iso(T0) },
  },
  {
    name: '#2b no timestamps: CANCELLED, late SUSPENDED, then ACTIVATED stays cancelled',
    steps: [
      { raw: sub('ACTIVATED'), decision: 'applied' },
      { raw: sub('CANCELLED'), decision: 'applied', effects: ['status_changed'] },
      { raw: sub('SUSPENDED'), decision: 'noop', reason: 'transition_rejected' },
      { raw: sub('ACTIVATED'), decision: 'noop', reason: 'transition_rejected' },
    ],
    expectState: { status: 'cancelled' },
  },
  {
    name: '#2b with update_time: late SUSPENDED is stale, newer ACTIVATED cannot revive',
    steps: [
      { raw: sub('ACTIVATED', T0), decision: 'applied' },
      { raw: sub('CANCELLED', T2), decision: 'applied' },
      { raw: sub('SUSPENDED', T1), decision: 'noop', reason: 'stale' },
      { raw: sub('ACTIVATED', T3), decision: 'noop', reason: 'transition_rejected' },
    ],
    expectState: { status: 'cancelled', stateAt: iso(T2) },
  },
  {
    name: '#2b expired is terminal too',
    start: { status: 'expired' },
    steps: [{ raw: sub('RE-ACTIVATED'), decision: 'noop', reason: 'transition_rejected' }],
    expectState: { status: 'expired' },
  },
  {
    name: '#2c lookup ACTIVE wins over a stale CREATED, late CREATED afterwards is ignored',
    steps: [
      { raw: lookup('ACTIVE', T1), source: 'lookup', decision: 'applied', effects: ['status_changed'] },
      { raw: sub('CREATED', T0), decision: 'noop', reason: 'stale' },
    ],
    expectState: { status: 'active', stateAt: iso(T1), providerPlanId: 'P-1' },
  },
  {
    name: '#2c lookup older than the watermark still wins (provider is authoritative)',
    start: { status: 'suspended', stateAt: iso(T2) },
    steps: [{ raw: lookup('ACTIVE', T1), source: 'lookup', decision: 'applied', effects: ['status_changed'] }],
    expectState: { status: 'active', stateAt: iso(T2) },
  },
  {
    name: '#2c lookup cannot revive a cancelled subscription',
    start: { status: 'cancelled' },
    steps: [{ raw: lookup('ACTIVE', T1), source: 'lookup', decision: 'noop', reason: 'transition_rejected' }],
    expectState: { status: 'cancelled' },
  },
  {
    name: 'lookup with an unknown provider status changes nothing about the status',
    start: { status: 'active' },
    steps: [{ raw: lookup('SOMETHING_NEW', T1), source: 'lookup', decision: 'applied', effects: [] }],
    expectState: { status: 'active' },
  },
  {
    name: 'late CREATED never moves suspended back to approval_pending',
    start: { status: 'suspended' },
    steps: [{ raw: sub('CREATED'), decision: 'noop', reason: 'transition_rejected' }],
    expectState: { status: 'suspended' },
  },
  {
    name: 'APPROVED then ACTIVATED moves forward',
    steps: [
      { raw: sub('APPROVED', T0), decision: 'applied' },
      { raw: sub('ACTIVATED', T1), decision: 'applied' },
    ],
    expectState: { status: 'active' },
  },
  {
    name: 'suspend and re-activate toggle',
    steps: [
      { raw: sub('ACTIVATED', T0), decision: 'applied' },
      { raw: sub('SUSPENDED', T1), decision: 'applied', effects: ['status_changed'] },
      { raw: sub('RE-ACTIVATED', T2), decision: 'applied', effects: ['status_changed'] },
    ],
    expectState: { status: 'active', stateAt: iso(T2) },
  },

  // ---- Review focus 2: equal and missing timestamps -------------------------
  {
    name: 'equal stateAt with a conflicting status is a noop',
    steps: [
      { raw: sub('ACTIVATED', T1), decision: 'applied' },
      { raw: sub('SUSPENDED', T1), decision: 'noop', reason: 'equal_conflict' },
    ],
    expectState: { status: 'active', stateAt: iso(T1) },
  },
  {
    name: 'equal stateAt with the same status applies (redelivery of the same state)',
    steps: [
      { raw: sub('ACTIVATED', T1), decision: 'applied' },
      { raw: sub('ACTIVATED', T1), decision: 'applied', effects: [] },
    ],
    expectState: { status: 'active', stateAt: iso(T1) },
  },
  {
    name: 'missing timestamp after a watermark is a noop',
    steps: [
      { raw: sub('ACTIVATED', T1), decision: 'applied' },
      { raw: sub('SUSPENDED'), decision: 'noop', reason: 'missing_timestamp' },
    ],
    expectState: { status: 'active', stateAt: iso(T1) },
  },
  {
    name: 'missing timestamp without a watermark applies',
    steps: [{ raw: sub('SUSPENDED'), decision: 'applied' }],
    expectState: { status: 'suspended', stateAt: null },
  },
  {
    name: 'invalid stored watermark is treated as absent',
    start: { status: 'active', stateAt: 'not-a-date' },
    steps: [{ raw: sub('SUSPENDED', T1), decision: 'applied' }],
    expectState: { status: 'suspended', stateAt: iso(T1) },
  },
  {
    name: 'duplicate delivery of the last event id is a noop',
    steps: [
      {
        raw: JSON.stringify({
          id: 'WH-DUP',
          event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
          resource: { id: 'I-SUB' },
        }),
        decision: 'applied',
      },
      {
        raw: JSON.stringify({
          id: 'WH-DUP',
          event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
          resource: { id: 'I-SUB' },
        }),
        decision: 'noop',
        reason: 'duplicate_event',
      },
    ],
    expectState: { status: 'active', lastEventId: 'WH-DUP' },
  },

  // ---- Issue #4: billing data and plan checks ------------------------------
  {
    name: '#4 UPDATED stores billing fields and reports period_updated',
    start: { status: 'active', providerPlanId: 'P-1' },
    steps: [
      {
        raw: sub('UPDATED', T1, {
          status: 'ACTIVE',
          plan_id: 'P-1',
          start_time: '2026-10-22T00:00:00Z',
          billing_info: {
            next_billing_time: '2026-11-22T10:00:00Z',
            last_payment: { amount: { currency_code: 'USD', value: '9.99' }, time: T0 },
            failed_payments_count: 0,
          },
        }),
        decision: 'applied',
        effects: ['period_updated'],
      },
    ],
    expectState: {
      status: 'active',
      nextBillingTime: '2026-11-22T10:00:00.000Z',
      startTime: '2026-10-22T00:00:00.000Z',
      lastPayment: { amountMinor: '999', currency: 'USD', time: iso(T0) },
      failedPaymentsCount: 0,
    },
  },
  {
    name: '#4 ACTIVATED with another plan_id than the stored one does not apply',
    start: { status: 'approval_pending', providerPlanId: 'P-1' },
    steps: [
      {
        raw: sub('ACTIVATED', T1, { plan_id: 'P-OTHER' }),
        decision: 'noop',
        reason: 'plan_mismatch',
        effects: ['plan_mismatch'],
      },
    ],
    expectState: { status: 'approval_pending', providerPlanId: 'P-1', stateAt: null },
  },
  {
    name: '#4 expectedPlanId overrides the stored plan (host-side plan change)',
    start: { status: 'active', providerPlanId: 'P-1' },
    steps: [
      {
        raw: sub('UPDATED', T1, { status: 'ACTIVE', plan_id: 'P-2' }),
        options: { expectedPlanId: 'P-2' },
        decision: 'applied',
      },
    ],
    expectState: { status: 'active', providerPlanId: 'P-2' },
  },
  {
    name: '#4 expectedPlanId rejects an event plan even when nothing is stored',
    steps: [
      {
        raw: sub('ACTIVATED', T1, { plan_id: 'P-OTHER' }),
        options: { expectedPlanId: 'P-1' },
        decision: 'noop',
        reason: 'plan_mismatch',
        effects: ['plan_mismatch'],
      },
    ],
    expectState: { status: 'approval_pending', providerPlanId: null },
  },
  {
    name: '#4 PAYMENT.SALE.COMPLETED 0.01 JPY against a USD price is a currency mismatch',
    start: { status: 'active' },
    steps: [
      {
        raw: sale('COMPLETED', '0.01', 'JPY'),
        options: { expectedPayment: PRICE },
        decision: 'noop',
        reason: 'currency_mismatch',
        effects: ['currency_mismatch'],
      },
    ],
    expectState: { status: 'active', lastPayment: null },
  },
  {
    name: '#4 PAYMENT.SALE.COMPLETED 0.01 JPY against a JPY price is an amount mismatch',
    start: { status: 'active' },
    steps: [
      {
        raw: sale('COMPLETED', '0.01', 'JPY'),
        options: { expectedPayment: { amountMinor: '1000', currency: 'JPY' } },
        decision: 'noop',
        reason: 'amount_mismatch',
        effects: ['amount_mismatch'],
      },
    ],
    expectState: { status: 'active', lastPayment: null },
  },
  {
    name: '#4 lower amount is an amount mismatch and does not change status',
    start: { status: 'suspended' },
    steps: [
      {
        raw: sale('COMPLETED', '9.98', 'USD'),
        options: { expectedPayment: PRICE },
        decision: 'noop',
        reason: 'amount_mismatch',
        effects: ['amount_mismatch'],
      },
    ],
    expectState: { status: 'suspended', lastPayment: null },
  },
  {
    name: 'money: "10" and "10.00" are the same amount',
    start: { status: 'active' },
    steps: [
      {
        raw: sale('COMPLETED', '10', 'USD'),
        options: { expectedPayment: { amountMinor: '1000', currency: 'USD' } },
        decision: 'applied',
        effects: ['payment_completed'],
      },
      {
        raw: sale('COMPLETED', '10.00', 'usd'),
        options: { expectedPayment: { amountMinor: '1000', currency: 'usd' } },
        decision: 'applied',
        effects: ['payment_completed'],
      },
    ],
    expectState: { lastPayment: { amountMinor: '1000', currency: 'USD', time: iso(T0) } },
  },
  {
    name: 'money: JPY has no minor digits',
    start: { status: 'active' },
    steps: [
      {
        raw: sale('COMPLETED', '1000', 'JPY'),
        options: { expectedPayment: { amountMinor: '1000', currency: 'JPY' } },
        decision: 'applied',
        effects: ['payment_completed'],
      },
    ],
    expectState: { lastPayment: { amountMinor: '1000', currency: 'JPY', time: iso(T0) } },
  },
  {
    name: 'money: a higher amount (tax, setup fee) is accepted',
    start: { status: 'active' },
    steps: [
      {
        raw: sale('COMPLETED', '10.99', 'USD'),
        options: { expectedPayment: PRICE },
        decision: 'applied',
        effects: ['payment_completed'],
      },
    ],
    expectState: { lastPayment: { amountMinor: '1099', currency: 'USD', time: iso(T0) } },
  },
  {
    name: 'money: a numeric amount is never trusted when a price is expected',
    start: { status: 'active' },
    steps: [
      {
        raw: sale('COMPLETED', 9.99, 'USD'),
        options: { expectedPayment: PRICE },
        decision: 'noop',
        reason: 'amount_mismatch',
        effects: ['amount_mismatch'],
      },
    ],
    expectState: { lastPayment: null },
  },
  {
    name: 'money: a malformed expected price fails closed',
    start: { status: 'active' },
    steps: [
      {
        raw: sale('COMPLETED', '9.99', 'USD'),
        options: { expectedPayment: { amountMinor: '9.99', currency: 'USD' } },
        decision: 'noop',
        reason: 'amount_mismatch',
        effects: ['amount_mismatch'],
      },
    ],
    expectState: { lastPayment: null },
  },
  {
    name: 'sale without an expected price records the payment',
    start: { status: 'active' },
    steps: [{ raw: sale('COMPLETED', '9.99', 'USD'), decision: 'applied', effects: ['payment_completed'] }],
    expectState: { status: 'active', lastPayment: { amountMinor: '999', currency: 'USD', time: iso(T0) } },
  },
  {
    name: 'an older sale does not move lastPayment back',
    start: {
      status: 'active',
      lastPayment: { amountMinor: '999', currency: 'USD', time: iso(T2) },
    },
    steps: [{ raw: sale('COMPLETED', '9.99', 'USD'), decision: 'applied', effects: ['payment_completed'] }],
    expectState: { lastPayment: { amountMinor: '999', currency: 'USD', time: iso(T2) } },
  },
  {
    name: '#4 PAYMENT.FAILED takes the counter from the resource',
    start: { status: 'active', failedPaymentsCount: 0 },
    steps: [
      {
        raw: sub('PAYMENT.FAILED', T1, {
          status: 'ACTIVE',
          billing_info: {
            failed_payments_count: 2,
            outstanding_balance: { currency_code: 'USD', value: '9.99' },
          },
        }),
        decision: 'applied',
        effects: ['payment_failed'],
      },
    ],
    expectState: { status: 'active', failedPaymentsCount: 2, stateAt: null },
  },
  {
    name: '#4 PAYMENT.FAILED without a counter increments the stored one',
    start: { status: 'active', failedPaymentsCount: 1 },
    steps: [
      { raw: sub('PAYMENT.FAILED'), decision: 'applied', effects: ['payment_failed'] },
      { raw: sub('PAYMENT.FAILED'), decision: 'applied', effects: ['payment_failed'] },
    ],
    expectState: { status: 'active', failedPaymentsCount: 3 },
  },
  {
    name: 'refund and reversal are reported and change no status',
    start: { status: 'active' },
    steps: [
      { raw: sale('REFUNDED', '9.99', 'USD', { sale_id: 'SALE-X' }), decision: 'applied', effects: ['refund_or_reversal'] },
      { raw: sale('REVERSED', '9.99', 'USD'), decision: 'applied', effects: ['refund_or_reversal'] },
    ],
    expectState: { status: 'active' },
  },
  // ---- Fix wave: plan check gates only moves to approved/active ------------
  {
    name: 'plan: revise to P-2 then CANCELLED still cancels and reports the mismatch',
    start: { status: 'active', providerPlanId: 'P-1' },
    steps: [
      {
        raw: sub('CANCELLED', T1, { plan_id: 'P-2' }),
        decision: 'applied',
        effects: ['plan_mismatch', 'status_changed'],
      },
    ],
    expectState: { status: 'cancelled', providerPlanId: 'P-1', stateAt: iso(T1) },
  },
  {
    name: 'plan: revise to P-2 then SUSPENDED still suspends and reports the mismatch',
    start: { status: 'active', providerPlanId: 'P-1' },
    steps: [
      {
        raw: sub('SUSPENDED', T1, { plan_id: 'P-2' }),
        decision: 'applied',
        effects: ['plan_mismatch', 'status_changed'],
      },
    ],
    expectState: { status: 'suspended', providerPlanId: 'P-1' },
  },
  {
    name: 'plan: lookup CANCELLED on the new plan applies and reports the mismatch',
    start: { status: 'active', providerPlanId: 'P-1' },
    steps: [
      {
        raw: lookup('CANCELLED', T1, { plan_id: 'P-2' }),
        source: 'lookup',
        decision: 'applied',
        effects: ['plan_mismatch', 'status_changed'],
      },
    ],
    expectState: { status: 'cancelled', providerPlanId: 'P-1' },
  },
  {
    name: 'plan: PAYMENT.FAILED on the new plan is recorded and reports the mismatch',
    start: { status: 'active', providerPlanId: 'P-1', failedPaymentsCount: 0 },
    steps: [
      {
        raw: sub('PAYMENT.FAILED', T1, { plan_id: 'P-2', billing_info: { failed_payments_count: 1 } }),
        decision: 'applied',
        effects: ['plan_mismatch', 'payment_failed'],
      },
    ],
    expectState: { status: 'active', providerPlanId: 'P-1', failedPaymentsCount: 1 },
  },
  {
    name: 'plan: UPDATED keeping active on another plan is not applied',
    start: { status: 'active', providerPlanId: 'P-1' },
    steps: [
      {
        raw: sub('UPDATED', T1, { status: 'ACTIVE', plan_id: 'P-2', billing_info: { next_billing_time: T3 } }),
        decision: 'noop',
        reason: 'plan_mismatch',
        effects: ['plan_mismatch'],
      },
    ],
    expectState: { status: 'active', providerPlanId: 'P-1', nextBillingTime: null },
  },
  {
    name: 'plan: a lookup adopts the new plan when the host passes it as expectedPlanId',
    start: { status: 'active', providerPlanId: 'P-1' },
    steps: [
      {
        raw: lookup('ACTIVE', T1, { plan_id: 'P-2' }),
        source: 'lookup',
        options: { expectedPlanId: 'P-2' },
        decision: 'applied',
        effects: [],
      },
    ],
    expectState: { status: 'active', providerPlanId: 'P-2' },
  },

  // ---- Fix wave: redelivery dedupe beyond the previous event ---------------
  {
    name: 'dedupe: SALE.COMPLETED, UPDATED, then the same SALE.COMPLETED again is a noop',
    start: { status: 'active' },
    steps: [
      {
        raw: withId(sale('COMPLETED', '9.99', 'USD', { id: 'SALE-A' }), 'WH-PAY'),
        decision: 'applied',
        effects: ['payment_completed'],
      },
      { raw: sub('UPDATED', T1, { status: 'ACTIVE' }), decision: 'applied' },
      {
        raw: withId(sale('COMPLETED', '9.99', 'USD', { id: 'SALE-A' }), 'WH-PAY'),
        decision: 'noop',
        reason: 'duplicate_event',
        effects: [],
      },
    ],
    expectState: { lastPayment: { amountMinor: '999', currency: 'USD', time: iso(T0) } },
  },
  {
    name: 'dedupe: the same sale under a new webhook id is a noop',
    start: { status: 'active' },
    steps: [
      { raw: sale('COMPLETED', '9.99', 'USD', { id: 'SALE-B' }), decision: 'applied' },
      {
        raw: sale('COMPLETED', '9.99', 'USD', { id: 'SALE-B' }),
        decision: 'noop',
        reason: 'duplicate_event',
        effects: [],
      },
    ],
    expectState: { recentSaleIds: ['SALE-B'] },
  },
  {
    name: 'dedupe: PAYMENT.FAILED, UPDATED, then the same PAYMENT.FAILED again keeps the counter',
    start: { status: 'active', failedPaymentsCount: 0 },
    steps: [
      { raw: withId(sub('PAYMENT.FAILED'), 'WH-F'), decision: 'applied', effects: ['payment_failed'] },
      { raw: sub('UPDATED', T1, { status: 'ACTIVE' }), decision: 'applied' },
      {
        raw: withId(sub('PAYMENT.FAILED'), 'WH-F'),
        decision: 'noop',
        reason: 'duplicate_event',
        effects: [],
      },
    ],
    expectState: { failedPaymentsCount: 1 },
  },

  // ---- Fix wave: late APPROVED, subscription id, counters, refunds ---------
  {
    name: 'late APPROVED without timestamps never moves active back to approved',
    start: { status: 'active' },
    steps: [{ raw: sub('APPROVED'), decision: 'noop', reason: 'transition_rejected' }],
    expectState: { status: 'active' },
  },
  {
    name: 'late APPROVED never moves suspended back to approved',
    start: { status: 'suspended' },
    steps: [{ raw: sub('APPROVED'), decision: 'noop', reason: 'transition_rejected' }],
    expectState: { status: 'suspended' },
  },
  {
    name: 'the subscription id is learned from the first event; another id is then ignored',
    steps: [
      { raw: sub('ACTIVATED', T0), decision: 'applied' },
      {
        raw: sub('CANCELLED', T1, { id: 'I-OTHER' }),
        decision: 'noop',
        reason: 'subscription_mismatch',
      },
      {
        raw: sale('COMPLETED', '9.99', 'USD', { billing_agreement_id: 'I-OTHER' }),
        decision: 'noop',
        reason: 'subscription_mismatch',
      },
    ],
    expectState: { status: 'active', providerSubscriptionId: 'I-SUB', lastPayment: null },
  },
  {
    name: 'the subscription id is also learned from a sale',
    steps: [{ raw: sale('COMPLETED', '9.99', 'USD'), decision: 'applied' }],
    expectState: { providerSubscriptionId: 'I-SUB' },
  },
  {
    name: 'failedPaymentsCount: an out-of-order PAYMENT.FAILED never lowers the counter',
    start: { status: 'active', failedPaymentsCount: 3 },
    steps: [
      {
        raw: sub('PAYMENT.FAILED', undefined, { billing_info: { failed_payments_count: 1 } }),
        decision: 'applied',
        effects: ['payment_failed'],
      },
    ],
    expectState: { failedPaymentsCount: 3 },
  },
  {
    name: 'failedPaymentsCount: UPDATED without a newer payment never lowers the counter',
    start: {
      status: 'active',
      failedPaymentsCount: 3,
      lastPayment: { amountMinor: '999', currency: 'USD', time: iso(T1) },
    },
    steps: [
      {
        raw: sub('UPDATED', T2, {
          status: 'ACTIVE',
          billing_info: {
            failed_payments_count: 0,
            last_payment: { amount: { currency_code: 'USD', value: '9.99' }, time: T1 },
          },
        }),
        decision: 'applied',
      },
    ],
    expectState: { failedPaymentsCount: 3 },
  },
  {
    name: 'failedPaymentsCount: UPDATED with a newer last payment resets the counter',
    start: {
      status: 'active',
      failedPaymentsCount: 3,
      lastPayment: { amountMinor: '999', currency: 'USD', time: iso(T0) },
    },
    steps: [
      {
        raw: sub('UPDATED', T2, {
          status: 'ACTIVE',
          billing_info: {
            failed_payments_count: 0,
            last_payment: { amount: { currency_code: 'USD', value: '9.99' }, time: T1 },
          },
        }),
        decision: 'applied',
      },
    ],
    expectState: {
      failedPaymentsCount: 0,
      lastPayment: { amountMinor: '999', currency: 'USD', time: iso(T1) },
    },
  },
  {
    name: 'failedPaymentsCount: RE-ACTIVATED resets the counter when the resource says so',
    start: { status: 'suspended', failedPaymentsCount: 3 },
    steps: [
      {
        raw: sub('RE-ACTIVATED', T1, { billing_info: { failed_payments_count: 0 } }),
        decision: 'applied',
        effects: ['status_changed'],
      },
    ],
    expectState: { status: 'active', failedPaymentsCount: 0 },
  },
  {
    name: 'refund and reversal keep a signed amount',
    start: { status: 'active' },
    steps: [
      { raw: sale('REFUNDED', '-10.00', 'USD', { sale_id: 'SALE-R' }), decision: 'applied', effects: ['refund_or_reversal'] },
      { raw: sale('REVERSED', '-10.00', 'USD'), decision: 'applied', effects: ['refund_or_reversal'] },
    ],
    expectState: { status: 'active' },
  },
];

describe('reduceSubscription vectors', () => {
  it.each(vectors.map((v) => [v.name, v] as const))('%s', (_name, vector) => {
    let state = initialSubscriptionState(vector.start);
    vector.steps.forEach((step, index) => {
      const event = normalize(step);
      const before = structuredClone(state);
      const frozen = Object.freeze(structuredClone(state));
      const result: ReduceSubscriptionResult = reduceSubscription(frozen, event, {
        source: step.source ?? 'webhook',
        ...step.options,
      });
      const label = `step ${index + 1} (${event.eventType})`;
      expect(state, `${label} mutated its input`).toEqual(before);
      expect(result.decision, label).toBe(step.decision);
      expect(result.reason, label).toBe(step.reason);
      if (step.effects) {
        expect(result.effects.map((e) => e.type), label).toEqual(step.effects);
      }
      if (result.decision === 'noop') {
        expect(result.state, `${label} noop must return the input state`).toEqual(before);
      }
      expect(result.state, `${label} must not return the input object`).not.toBe(frozen);
      // Deterministic: the same input gives the same output.
      expect(reduceSubscription(frozen, event, { source: step.source ?? 'webhook', ...step.options })).toEqual(
        result,
      );
      state = result.state;
    });
    expect(state).toMatchObject(vector.expectState);
  });
});

describe('reduceSubscription effects payloads', () => {
  const reduceRaw = (
    state: SubscriptionState,
    raw: string,
    options: ReduceSubscriptionOptions = { source: 'webhook' },
  ) => {
    const result = normalizePaypalSubscriptionEvent(raw);
    if (!result.ok) throw new Error(result.reason);
    return reduceSubscription(state, result.event, options);
  };

  it('status_changed carries from and to', () => {
    const result = reduceRaw(initialSubscriptionState(), sub('ACTIVATED', T0));
    expect(result.effects).toEqual([{ type: 'status_changed', from: 'approval_pending', to: 'active' }]);
    expect(result.state.lastEventId).toMatch(/^WH-/);
  });

  it('mismatch effects carry expected and actual values', () => {
    const state = initialSubscriptionState({ status: 'active', providerPlanId: 'P-1' });
    expect(reduceRaw(state, sub('ACTIVATED', T0, { plan_id: 'P-9' })).effects).toEqual([
      { type: 'plan_mismatch', expectedPlanId: 'P-1', actualPlanId: 'P-9' },
    ]);
    const currency = reduceRaw(state, sale('COMPLETED', '9.99', 'EUR'), {
      source: 'webhook',
      expectedPayment: PRICE,
    });
    expect(currency.effects).toEqual([
      {
        type: 'currency_mismatch',
        expectedCurrency: 'USD',
        actualCurrency: 'EUR',
        saleId: expect.stringMatching(/^SALE-/),
      },
    ]);
    const amount = reduceRaw(state, sale('COMPLETED', '1.00', 'USD'), {
      source: 'webhook',
      expectedPayment: PRICE,
    });
    expect(amount.effects).toEqual([
      {
        type: 'amount_mismatch',
        expected: { amountMinor: '999', currency: 'USD' },
        actual: { amountMinor: '100', currency: 'USD' },
        saleId: expect.stringMatching(/^SALE-/),
      },
    ]);
  });

  it('payment_completed, payment_failed, refund_or_reversal and period_updated payloads', () => {
    const state = initialSubscriptionState({ status: 'active' });
    expect(reduceRaw(state, sale('COMPLETED', '9.99', 'USD')).effects[0]).toEqual({
      type: 'payment_completed',
      amountMinor: '999',
      currency: 'USD',
      saleId: expect.stringMatching(/^SALE-/),
      time: iso(T0),
    });
    expect(
      reduceRaw(
        state,
        sub('PAYMENT.FAILED', undefined, {
          billing_info: { outstanding_balance: { currency_code: 'USD', value: '9.99' } },
        }),
      ).effects[0],
    ).toEqual({
      type: 'payment_failed',
      failedPaymentsCount: 1,
      outstandingBalance: { amountMinor: '999', currency: 'USD' },
    });
    expect(reduceRaw(state, sale('REVERSED', '9.99', 'USD')).effects[0]).toEqual({
      type: 'refund_or_reversal',
      eventType: 'PAYMENT.SALE.REVERSED',
      amountMinor: '999',
      currency: 'USD',
      saleId: expect.stringMatching(/^SALE-/),
    });
    expect(
      reduceRaw(state, sub('UPDATED', T1, { billing_info: { next_billing_time: T3 } })).effects,
    ).toEqual([{ type: 'period_updated', nextBillingTime: iso(T3), startTime: null }]);
  });

  it('an event for a different subscription is a noop when the state knows its id', () => {
    const state = initialSubscriptionState({ status: 'active', providerSubscriptionId: 'I-OTHER' });
    const result = reduceRaw(state, sub('CANCELLED', T0));
    expect(result).toMatchObject({ decision: 'noop', reason: 'subscription_mismatch', effects: [] });
    expect(result.state).toEqual(state);
    expect(result.state).not.toBe(state);
  });

  it('refund_or_reversal keeps the sign of a negative total', () => {
    const result = reduceRaw(initialSubscriptionState({ status: 'active' }), sale('REVERSED', '-10.00', 'USD'));
    expect(result.effects[0]).toMatchObject({ type: 'refund_or_reversal', amountMinor: '-1000', currency: 'USD' });
  });

  it('plan_mismatch on an applied cancellation carries expected and actual plan', () => {
    const state = initialSubscriptionState({ status: 'active', providerPlanId: 'P-1' });
    expect(reduceRaw(state, sub('CANCELLED', T1, { plan_id: 'P-2' })).effects).toEqual([
      { type: 'plan_mismatch', expectedPlanId: 'P-1', actualPlanId: 'P-2' },
      { type: 'status_changed', from: 'active', to: 'cancelled' },
    ]);
  });

  it('keeps at most 16 recent event ids and sale ids', () => {
    let state = initialSubscriptionState({ status: 'active' });
    for (let i = 0; i < 20; i += 1) {
      state = reduceRaw(state, sale('COMPLETED', '9.99', 'USD')).state;
    }
    expect(state.recentEventIds).toHaveLength(16);
    expect(state.recentSaleIds).toHaveLength(16);
    expect(state.lastEventId).toBe(state.recentEventIds.at(-1));
  });

  it('tolerates a stored state without the recent-id lists (older host rows)', () => {
    const legacy = { ...initialSubscriptionState({ status: 'active' }) } as Partial<SubscriptionState>;
    delete legacy.recentEventIds;
    delete legacy.recentSaleIds;
    const result = reduceRaw(legacy as SubscriptionState, sale('COMPLETED', '9.99', 'USD'));
    expect(result.decision).toBe('applied');
    expect(result.state.recentEventIds).toHaveLength(1);
  });
});

describe('reduceSubscription returns state that shares no references', () => {
  it('copies objects taken from the event and from the input state', () => {
    const lastPayment = { amountMinor: '999', currency: 'USD', time: iso(T0) };
    const input = initialSubscriptionState({ status: 'active', lastPayment });
    const normalized = normalizePaypalSubscriptionEvent(
      sub('PAYMENT.FAILED', T1, {
        billing_info: { outstanding_balance: { currency_code: 'USD', value: '9.99' } },
      }),
    );
    if (!normalized.ok) throw new Error(normalized.reason);
    const failed = reduceSubscription(input, normalized.event, { source: 'webhook' });
    expect(failed.state.lastPayment).toEqual(lastPayment);
    expect(failed.state.lastPayment).not.toBe(lastPayment);
    expect(failed.state.recentEventIds).not.toBe(input.recentEventIds);
    const effect = failed.effects[0];
    expect(effect?.type === 'payment_failed' && effect.outstandingBalance).not.toBe(
      normalized.event.outstandingBalance,
    );

    const updated = normalizePaypalSubscriptionEvent(
      sub('UPDATED', T2, {
        billing_info: { last_payment: { amount: { currency_code: 'USD', value: '9.99' }, time: T2 } },
      }),
    );
    if (!updated.ok) throw new Error(updated.reason);
    const applied = reduceSubscription(input, updated.event, { source: 'webhook' });
    expect(applied.state.lastPayment).toEqual(updated.event.lastPayment);
    expect(applied.state.lastPayment).not.toBe(updated.event.lastPayment);

    const noop = reduceSubscription(applied.state, updated.event, { source: 'webhook' });
    expect(noop.decision).toBe('noop');
    expect(noop.state).not.toBe(applied.state);
    expect(noop.state.lastPayment).not.toBe(applied.state.lastPayment);
  });
});

describe('initialSubscriptionState', () => {
  it('starts at approval_pending with empty fields', () => {
    expect(initialSubscriptionState()).toEqual({
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
    });
  });
});
