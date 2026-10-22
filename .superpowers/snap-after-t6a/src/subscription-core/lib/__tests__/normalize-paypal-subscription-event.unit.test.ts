import { describe, expect, it } from 'vitest';
import {
  deriveProviderEventId,
  isFreshTransmission,
  normalizePaypalSubscriptionEvent,
} from '../normalize-paypal-subscription-event';

const subscriptionBody = (overrides: Record<string, unknown> = {}, resource: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: 'WH-1',
    event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
    resource_type: 'subscription',
    create_time: '2026-10-22T10:00:01Z',
    ...overrides,
    resource: {
      id: 'I-SUB',
      plan_id: 'P-1',
      status: 'ACTIVE',
      start_time: '2026-10-22T00:00:00Z',
      create_time: '2026-10-22T09:00:00Z',
      update_time: '2026-10-22T10:00:00Z',
      billing_info: {
        next_billing_time: '2026-11-22T10:00:00Z',
        last_payment: { amount: { currency_code: 'USD', value: '9.99' }, time: '2026-10-22T10:00:00Z' },
        failed_payments_count: 0,
        outstanding_balance: { currency_code: 'USD', value: '0.00' },
      },
      ...resource,
    },
  });

describe('normalizePaypalSubscriptionEvent', () => {
  it('normalises a subscription event', () => {
    const result = normalizePaypalSubscriptionEvent(subscriptionBody());
    expect(result).toEqual({
      ok: true,
      event: {
        providerEventId: 'WH-1',
        eventType: 'BILLING.SUBSCRIPTION.ACTIVATED',
        resourceType: 'subscription',
        providerSubscriptionId: 'I-SUB',
        providerPlanId: 'P-1',
        providerStatus: 'ACTIVE',
        subscriptionStatus: 'active',
        stateAt: '2026-10-22T10:00:00.000Z',
        nextBillingTime: '2026-11-22T10:00:00.000Z',
        startTime: '2026-10-22T00:00:00.000Z',
        lastPayment: { amountMinor: '999', currency: 'USD', time: '2026-10-22T10:00:00.000Z' },
        failedPaymentsCount: 0,
        outstandingBalance: { amountMinor: '0', currency: 'USD' },
        payment: null,
        eventTime: '2026-10-22T10:00:01.000Z',
      },
    });
  });

  it('falls back to resource create_time for stateAt and leaves absent fields null', () => {
    const result = normalizePaypalSubscriptionEvent(
      JSON.stringify({
        id: 'WH-2',
        event_type: 'BILLING.SUBSCRIPTION.CREATED',
        resource: { id: 'I-SUB', create_time: '2026-10-22T09:00:00Z' },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event).toMatchObject({
      resourceType: 'subscription',
      stateAt: '2026-10-22T09:00:00.000Z',
      subscriptionStatus: 'approval_pending',
      providerPlanId: null,
      providerStatus: null,
      nextBillingTime: null,
      startTime: null,
      lastPayment: null,
      failedPaymentsCount: null,
      outstandingBalance: null,
      eventTime: null,
    });
  });

  it('uses the resource status for UPDATED events', () => {
    const result = normalizePaypalSubscriptionEvent(
      subscriptionBody({ event_type: 'BILLING.SUBSCRIPTION.UPDATED' }, { status: 'SUSPENDED' }),
    );
    expect(result.ok && result.event.subscriptionStatus).toBe('suspended');
  });

  it('never derives a subscription status from PAYMENT.FAILED', () => {
    const result = normalizePaypalSubscriptionEvent(
      subscriptionBody(
        { event_type: 'BILLING.SUBSCRIPTION.PAYMENT.FAILED' },
        { billing_info: { failed_payments_count: 2, outstanding_balance: { currency_code: 'USD', value: '9.99' } } },
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.subscriptionStatus).toBeNull();
    expect(result.event.failedPaymentsCount).toBe(2);
    expect(result.event.outstandingBalance).toEqual({ amountMinor: '999', currency: 'USD' });
  });

  it('normalises a PAYMENT.SALE.COMPLETED to the billing agreement', () => {
    const result = normalizePaypalSubscriptionEvent(
      JSON.stringify({
        id: 'WH-S',
        event_type: 'PAYMENT.SALE.COMPLETED',
        resource_type: 'sale',
        create_time: '2026-10-22T10:00:05Z',
        resource: {
          id: 'SALE-1',
          billing_agreement_id: 'I-SUB',
          state: 'completed',
          amount: { total: '10.00', currency: 'USD' },
          create_time: '2026-10-22T10:00:00Z',
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event).toMatchObject({
      providerEventId: 'WH-S',
      resourceType: 'sale',
      providerSubscriptionId: 'I-SUB',
      subscriptionStatus: null,
      providerPlanId: null,
      payment: { amountMinor: '1000', currency: 'USD', saleId: 'SALE-1' },
      stateAt: '2026-10-22T10:00:00.000Z',
    });
  });

  it('keeps the currency but nulls a sale amount that cannot be represented (0.01 JPY)', () => {
    const result = normalizePaypalSubscriptionEvent(
      JSON.stringify({
        id: 'WH-S',
        event_type: 'PAYMENT.SALE.COMPLETED',
        resource: { id: 'SALE-1', billing_agreement_id: 'I-SUB', amount: { total: '0.01', currency: 'JPY' } },
      }),
    );
    expect(result.ok && result.event.payment).toEqual({
      amountMinor: null,
      currency: 'JPY',
      saleId: 'SALE-1',
    });
  });

  it('uses sale_id for refunds', () => {
    const result = normalizePaypalSubscriptionEvent(
      JSON.stringify({
        id: 'WH-R',
        event_type: 'PAYMENT.SALE.REFUNDED',
        resource: {
          id: 'REF-1',
          sale_id: 'SALE-1',
          billing_agreement_id: 'I-SUB',
          amount: { total: '10.00', currency: 'USD' },
        },
      }),
    );
    expect(result.ok && result.event.payment).toEqual({
      amountMinor: '1000',
      currency: 'USD',
      saleId: 'SALE-1',
    });
  });

  it.each([
    ['PAYMENT.SALE.REFUNDED', '-10.00', '-1000'],
    ['PAYMENT.SALE.REVERSED', '-10.00', '-1000'],
    ['PAYMENT.SALE.REVERSED', '10.00', '1000'],
    ['PAYMENT.SALE.COMPLETED', '-10.00', null],
  ])('%s with total %s keeps amountMinor %s', (eventType, total, amountMinor) => {
    const result = normalizePaypalSubscriptionEvent(
      JSON.stringify({
        id: 'WH-N',
        event_type: eventType,
        resource: { id: 'X-1', billing_agreement_id: 'I-SUB', amount: { total, currency: 'USD' } },
      }),
    );
    expect(result.ok && result.event.payment?.amountMinor).toBe(amountMinor);
  });

  it.each<[string, string, string]>([
    ['invalid JSON', '{not json', 'invalid_json'],
    ['empty body', '', 'invalid_json'],
    ['JSON array', '[]', 'not_an_object'],
    ['JSON null', 'null', 'not_an_object'],
    ['JSON string', '"x"', 'not_an_object'],
    ['missing id', JSON.stringify({ event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 'I' } }), 'missing_event_id'],
    ['numeric id', JSON.stringify({ id: 123, event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 'I' } }), 'missing_event_id'],
    ['id with spaces', JSON.stringify({ id: 'WH 1', event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 'I' } }), 'missing_event_id'],
    ['missing event_type', JSON.stringify({ id: 'WH-1', resource: { id: 'I' } }), 'missing_event_type'],
    ['plan event', JSON.stringify({ id: 'WH-1', event_type: 'BILLING.PLAN.ACTIVATED', resource: { id: 'P' } }), 'unsupported_event_type'],
    ['checkout event', JSON.stringify({ id: 'WH-1', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: 'O' } }), 'unsupported_event_type'],
    ['unknown subscription event', JSON.stringify({ id: 'WH-1', event_type: 'BILLING.SUBSCRIPTION.SOMETHING', resource: { id: 'I' } }), 'unsupported_event_type'],
    ['missing resource', JSON.stringify({ id: 'WH-1', event_type: 'BILLING.SUBSCRIPTION.ACTIVATED' }), 'missing_resource'],
    ['resource is an array', JSON.stringify({ id: 'WH-1', event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: [] }), 'missing_resource'],
    ['numeric subscription id', JSON.stringify({ id: 'WH-1', event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 42 } }), 'missing_subscription_id'],
    ['sale without billing agreement', JSON.stringify({ id: 'WH-1', event_type: 'PAYMENT.SALE.COMPLETED', resource: { id: 'SALE-1', amount: { total: '1.00', currency: 'USD' } } }), 'missing_subscription_id'],
    ['oversized id', JSON.stringify({ id: 'W'.repeat(300), event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 'I' } }), 'missing_event_id'],
  ])('rejects %s', (_name, raw, reason) => {
    expect(normalizePaypalSubscriptionEvent(raw)).toEqual({ ok: false, reason });
  });

  it('never throws on hostile input', () => {
    const deep = '['.repeat(200_000) + ']'.repeat(200_000);
    const huge = subscriptionBody({ padding: 'x'.repeat(5_000_000) });
    const inputs: unknown[] = [
      undefined,
      null,
      42,
      {},
      deep,
      huge,
      '{"__proto__":{"id":"WH-1"},"event_type":"BILLING.SUBSCRIPTION.ACTIVATED","resource":{"id":"I"}}',
      '{"id":"WH-1","event_type":"BILLING.SUBSCRIPTION.ACTIVATED","resource":{"id":"I","billing_info":"x"}}',
      '{"id":"WH-1","event_type":"BILLING.SUBSCRIPTION.ACTIVATED","resource":{"id":"I","update_time":12}}',
    ];
    for (const input of inputs) {
      expect(() => normalizePaypalSubscriptionEvent(input as string)).not.toThrow();
    }
    expect(normalizePaypalSubscriptionEvent(undefined as unknown as string)).toEqual({
      ok: false,
      reason: 'invalid_json',
    });
    expect(normalizePaypalSubscriptionEvent(huge).ok).toBe(true);
    expect(
      normalizePaypalSubscriptionEvent(
        '{"__proto__":{"id":"WH-1"},"event_type":"BILLING.SUBSCRIPTION.ACTIVATED","resource":{"id":"I"}}',
      ),
    ).toEqual({ ok: false, reason: 'missing_event_id' });
  });

  it('decodes unicode escapes before validating ids', () => {
    const escaped = '{"id":"WH\\u002d1","event_type":"BILLING.SUBSCRIPTION.ACTIVATED","resource":{"id":"I\\u002dSUB"}}';
    const result = normalizePaypalSubscriptionEvent(escaped);
    expect(result.ok && result.event.providerEventId).toBe('WH-1');
    expect(result.ok && result.event.providerSubscriptionId).toBe('I-SUB');
    const control = '{"id":"WH\\u0000","event_type":"BILLING.SUBSCRIPTION.ACTIVATED","resource":{"id":"I"}}';
    expect(normalizePaypalSubscriptionEvent(control)).toEqual({ ok: false, reason: 'missing_event_id' });
    const rtl = '{"id":"WH-1","event_type":"BILLING.SUBSCRIPTION.ACTIVATED","resource":{"id":"I\\u202eX"}}';
    expect(normalizePaypalSubscriptionEvent(rtl)).toEqual({ ok: false, reason: 'missing_subscription_id' });
  });

  it('ignores invalid optional fields instead of failing the event', () => {
    const result = normalizePaypalSubscriptionEvent(
      subscriptionBody(
        { create_time: 'yesterday' },
        {
          update_time: 'not-a-date',
          create_time: '1',
          plan_id: 7,
          status: 'WEIRD',
          billing_info: {
            next_billing_time: 5,
            last_payment: { amount: { currency_code: 'USD', value: 9.99 } },
            failed_payments_count: -1,
          },
        },
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event).toMatchObject({
      stateAt: null,
      eventTime: null,
      providerPlanId: null,
      providerStatus: 'WEIRD',
      subscriptionStatus: 'active',
      nextBillingTime: null,
      lastPayment: null,
      failedPaymentsCount: null,
    });
  });
});

describe('deriveProviderEventId', () => {
  it('returns the body id or null', () => {
    expect(deriveProviderEventId(subscriptionBody())).toBe('WH-1');
    expect(deriveProviderEventId('{"id":5}')).toBeNull();
    expect(deriveProviderEventId('nope')).toBeNull();
    expect(deriveProviderEventId(undefined as unknown as string)).toBeNull();
  });
});

describe('isFreshTransmission', () => {
  const now = Date.parse('2026-10-22T10:00:00Z');
  const fifteenMinutes = 15 * 60 * 1000;

  it.each<[string | null | undefined, boolean]>([
    ['2026-10-22T10:00:00Z', true],
    ['2026-10-22T09:45:00Z', true],
    ['2026-10-22T09:44:59Z', false],
    ['2026-10-22T10:15:00Z', true],
    ['2026-10-22T10:15:01Z', false],
    ['2026-10-22T09:50:00.123+00:00', true],
    ['garbage', false],
    ['1', false],
    ['', false],
    [null, false],
    [undefined, false],
  ])('%j -> %s', (transmissionTime, expected) => {
    expect(isFreshTransmission(transmissionTime, now, fifteenMinutes)).toBe(expected);
  });

  it('accepts a Date for now and rejects an invalid skew', () => {
    expect(isFreshTransmission('2026-10-22T10:00:00Z', new Date(now), fifteenMinutes)).toBe(true);
    expect(isFreshTransmission('2026-10-22T10:00:00Z', now, -1)).toBe(false);
    expect(isFreshTransmission('2026-10-22T10:00:00Z', now, Number.NaN)).toBe(false);
    expect(isFreshTransmission('2026-10-22T10:00:00Z', Number.NaN, fifteenMinutes)).toBe(false);
  });
});
