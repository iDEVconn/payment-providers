import type { SubscriptionStatus } from '../../contracts/lib/subscription';
import {
  SUBSCRIPTION_LOOKUP_EVENT_TYPE,
  type NormalizeSubscriptionEventResult,
  type NormalizedSubscriptionEvent,
  type SubscriptionLastPayment,
  type SubscriptionMoney,
  type SubscriptionSalePayment,
} from './subscription-core-types';
import {
  normalizeCurrencyCode,
  parseDecimalToMinorUnits,
  parseSignedDecimalToMinorUnits,
} from './subscription-money';
import {
  SUBSCRIPTION_PAYMENT_FAILED_EVENT_TYPE,
  SUBSCRIPTION_SALE_EVENT_TYPES,
  mapPaypalSubscriptionStatus,
  mapSubscriptionWebhookEventToStatus,
  parseProviderTimestamp,
} from './subscription-status-rules';

export { isFreshTransmission } from './subscription-status-rules';

type JsonObject = Record<string, unknown>;

/** PayPal ids are printable ASCII without spaces (`WH-…`, `I-…`, `P-…`). */
const PROVIDER_ID_PATTERN = /^[\x21-\x7e]{1,128}$/;
const MAX_STATUS_LENGTH = 64;

const SUBSCRIPTION_EVENT_TYPES: ReadonlySet<string> = new Set([
  'BILLING.SUBSCRIPTION.CREATED',
  'BILLING.SUBSCRIPTION.APPROVED',
  'BILLING.SUBSCRIPTION.ACTIVATED',
  'BILLING.SUBSCRIPTION.RE-ACTIVATED',
  'BILLING.SUBSCRIPTION.UPDATED',
  'BILLING.SUBSCRIPTION.SUSPENDED',
  'BILLING.SUBSCRIPTION.CANCELLED',
  'BILLING.SUBSCRIPTION.EXPIRED',
  SUBSCRIPTION_PAYMENT_FAILED_EVENT_TYPE,
]);

const SALE_EVENT_TYPES: ReadonlySet<string> = new Set(SUBSCRIPTION_SALE_EVENT_TYPES);

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Own property only, so `__proto__` / inherited keys never leak in. */
function own(source: unknown, key: string): unknown {
  if (!isObject(source) || !Object.prototype.hasOwnProperty.call(source, key)) {
    return undefined;
  }
  return source[key];
}

function readId(value: unknown): string | null {
  return typeof value === 'string' && PROVIDER_ID_PATTERN.test(value) ? value : null;
}

function readCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * `{ currency_code, value }` (v2 shape) or `{ currency, total }` (v1 sale shape).
 * `signed` accepts a leading `-` (refund and reversal totals) and keeps it.
 */
function readMoneyParts(
  value: unknown,
  signed = false,
): { amountMinor: string | null; currency: string | null } | null {
  if (!isObject(value)) {
    return null;
  }
  const currency = normalizeCurrencyCode(own(value, 'currency_code') ?? own(value, 'currency'));
  const amount = own(value, 'value') ?? own(value, 'total');
  const parse = signed ? parseSignedDecimalToMinorUnits : parseDecimalToMinorUnits;
  const amountMinor = currency !== null && typeof amount === 'string' ? parse(amount, currency) : null;
  return { amountMinor, currency };
}

function readMoney(value: unknown): SubscriptionMoney | null {
  const parts = readMoneyParts(value);
  if (!parts || parts.amountMinor === null || parts.currency === null) {
    return null;
  }
  return { amountMinor: parts.amountMinor, currency: parts.currency };
}

function readLastPayment(value: unknown): SubscriptionLastPayment | null {
  const money = readMoney(own(value, 'amount'));
  if (!money) {
    return null;
  }
  return { ...money, time: parseProviderTimestamp(own(value, 'time')) };
}

function readStateAt(resource: JsonObject): string | null {
  // `update_time ?? create_time`, as the engine's watermark has always read it.
  const candidate = own(resource, 'update_time') ?? own(resource, 'create_time');
  return parseProviderTimestamp(candidate);
}

function readProviderStatus(resource: JsonObject): string | null {
  const status = own(resource, 'status');
  return typeof status === 'string' && status.length > 0 && status.length <= MAX_STATUS_LENGTH
    ? status
    : null;
}

function statusFromResource(providerStatus: string | null): SubscriptionStatus | null {
  if (!providerStatus) {
    return null;
  }
  const mapped = mapPaypalSubscriptionStatus(providerStatus);
  return mapped === 'unknown' ? null : mapped;
}

function parseJsonObject(rawBody: unknown): JsonObject | 'invalid_json' | 'not_an_object' {
  if (typeof rawBody !== 'string' || rawBody.length === 0) {
    return 'invalid_json';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return 'invalid_json';
  }
  return isObject(parsed) ? parsed : 'not_an_object';
}

function subscriptionResourceFields(resource: JsonObject) {
  const billingInfo = own(resource, 'billing_info');
  return {
    providerPlanId: readId(own(resource, 'plan_id')),
    providerStatus: readProviderStatus(resource),
    stateAt: readStateAt(resource),
    nextBillingTime: parseProviderTimestamp(own(billingInfo, 'next_billing_time')),
    startTime: parseProviderTimestamp(own(resource, 'start_time')),
    lastPayment: readLastPayment(own(billingInfo, 'last_payment')),
    failedPaymentsCount: readCount(own(billingInfo, 'failed_payments_count')),
    outstandingBalance: readMoney(own(billingInfo, 'outstanding_balance')),
  };
}

function normalizeOrThrow(rawBody: string): NormalizeSubscriptionEventResult {
  const body = parseJsonObject(rawBody);
  if (typeof body === 'string') {
    return { ok: false, reason: body };
  }

  const providerEventId = readId(own(body, 'id'));
  if (!providerEventId) {
    return { ok: false, reason: 'missing_event_id' };
  }
  const eventType = own(body, 'event_type');
  if (typeof eventType !== 'string' || eventType.length === 0) {
    return { ok: false, reason: 'missing_event_type' };
  }
  const isSale = SALE_EVENT_TYPES.has(eventType);
  if (!isSale && !SUBSCRIPTION_EVENT_TYPES.has(eventType)) {
    return { ok: false, reason: 'unsupported_event_type' };
  }
  const resource = own(body, 'resource');
  if (!isObject(resource)) {
    return { ok: false, reason: 'missing_resource' };
  }
  const eventTime = parseProviderTimestamp(own(body, 'create_time'));

  if (isSale) {
    const providerSubscriptionId = readId(own(resource, 'billing_agreement_id'));
    if (!providerSubscriptionId) {
      return { ok: false, reason: 'missing_subscription_id' };
    }
    const isCompleted = eventType === 'PAYMENT.SALE.COMPLETED';
    const money = readMoneyParts(own(resource, 'amount'), !isCompleted);
    const payment: SubscriptionSalePayment = {
      amountMinor: money?.amountMinor ?? null,
      currency: money?.currency ?? null,
      saleId: isCompleted
        ? readId(own(resource, 'id'))
          : (readId(own(resource, 'sale_id')) ?? readId(own(resource, 'id'))),
    };
    return {
      ok: true,
      event: {
        providerEventId,
        eventType,
        resourceType: 'sale',
        providerSubscriptionId,
        providerPlanId: null,
        providerStatus: null,
        subscriptionStatus: null,
        stateAt: readStateAt(resource),
        nextBillingTime: null,
        startTime: null,
        lastPayment: null,
        failedPaymentsCount: null,
        outstandingBalance: null,
        payment,
        eventTime,
      },
    };
  }

  const providerSubscriptionId = readId(own(resource, 'id'));
  if (!providerSubscriptionId) {
    return { ok: false, reason: 'missing_subscription_id' };
  }
  const fields = subscriptionResourceFields(resource);
  const subscriptionStatus =
    eventType === SUBSCRIPTION_PAYMENT_FAILED_EVENT_TYPE
      ? null
      : (mapSubscriptionWebhookEventToStatus(eventType) ?? statusFromResource(fields.providerStatus));
  return {
    ok: true,
    event: {
      providerEventId,
      eventType,
      resourceType: 'subscription',
      providerSubscriptionId,
      ...fields,
      subscriptionStatus,
      payment: null,
      eventTime,
    },
  };
}

/**
 * Normalise a PayPal subscription or subscription-sale webhook body. Never
 * throws: invalid JSON, a wrong shape or an event that is not about a
 * subscription gives `ok: false`. Invalid optional fields become null.
 */
export function normalizePaypalSubscriptionEvent(rawBody: string): NormalizeSubscriptionEventResult {
  try {
    return normalizeOrThrow(rawBody);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
}

/**
 * Normalise a PayPal `GET /v1/billing/subscriptions/{id}` response body into
 * the same event shape (`eventType` = `SUBSCRIPTION_LOOKUP_EVENT_TYPE`,
 * `providerEventId` = null), for `reduceSubscription(..., { source: 'lookup' })`.
 */
export function normalizePaypalSubscriptionResource(rawBody: string): NormalizeSubscriptionEventResult {
  try {
    const resource = parseJsonObject(rawBody);
    if (typeof resource === 'string') {
      return { ok: false, reason: resource };
    }
    const providerSubscriptionId = readId(own(resource, 'id'));
    if (!providerSubscriptionId) {
      return { ok: false, reason: 'missing_subscription_id' };
    }
    const fields = subscriptionResourceFields(resource);
    const event: NormalizedSubscriptionEvent = {
      providerEventId: null,
      eventType: SUBSCRIPTION_LOOKUP_EVENT_TYPE,
      resourceType: 'subscription',
      providerSubscriptionId,
      ...fields,
      subscriptionStatus: statusFromResource(fields.providerStatus),
      payment: null,
      eventTime: null,
    };
    return { ok: true, event };
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
}

/** The webhook body `id`, or null when absent or not a valid provider id. Never throws. */
export function deriveProviderEventId(rawBody: string): string | null {
  try {
    const body = parseJsonObject(rawBody);
    return typeof body === 'string' ? null : readId(own(body, 'id'));
  } catch {
    return null;
  }
}
