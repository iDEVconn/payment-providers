import type { SubscriptionStatus } from '../../contracts/lib/subscription';

/*
 * Single source of truth for PayPal subscription status mapping, transition
 * guards and provider-state ordering. `core/lib/subscription-transition-policy`
 * re-exports and builds on these; the engine and `reduceSubscription` share them.
 */

const SUBSCRIPTION_TERMINAL: ReadonlySet<SubscriptionStatus> = new Set(['cancelled', 'expired']);

/** States a late `CREATED` (approval_pending) must never move back from. */
const PAST_APPROVAL: ReadonlySet<SubscriptionStatus> = new Set(['approved', 'active', 'suspended']);

/** States a late `APPROVED` must never move back from (PayPal: APPROVAL_PENDING -> APPROVED -> ACTIVE). */
const PAST_ACTIVATION: ReadonlySet<SubscriptionStatus> = new Set(['active', 'suspended']);

const ISO_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):?(\d{2})))?$/i;

function inRange(value: string | undefined, min: number, max: number): boolean {
  if (value === undefined) {
    return true;
  }
  const n = Number(value);
  return n >= min && n <= max;
}

/** Reject dates `Date.parse` would roll over (Feb 30, 24:00, minute 60, offset +24:00). */
function hasValidParts(match: RegExpExecArray): boolean {
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = match;
  if (!inRange(month, 1, 12)) {
    return false;
  }
  // Day 0 of the next month is the last day of this one; pure and zone-independent.
  const daysInMonth = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  return (
    inRange(day, 1, daysInMonth) &&
    inRange(hour, 0, 23) &&
    inRange(minute, 0, 59) &&
    inRange(second, 0, 59) &&
    inRange(offsetHour, 0, 23) &&
    inRange(offsetMinute, 0, 59)
  );
}

/**
 * Parse a provider timestamp into a canonical ISO string. Accepts ISO 8601
 * dates and date-times with an explicit zone (so the result never depends on
 * the host time zone); anything else is null.
 */
export function parseProviderTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 40) {
    return null;
  }
  const match = ISO_TIMESTAMP_PATTERN.exec(trimmed);
  if (!match || !hasValidParts(match)) {
    return null;
  }
  const epochMs = Date.parse(trimmed);
  if (Number.isNaN(epochMs)) {
    return null;
  }
  return new Date(epochMs).toISOString();
}

/**
 * Compare an incoming provider timestamp with the stored watermark. Both go
 * through `parseProviderTimestamp`: an unparseable watermark counts as absent,
 * an unparseable incoming time never wins (`older`, or `equal` when both are absent).
 */
export function compareProviderStateTimestamps(
  stored: string | null,
  incoming: string,
): 'older' | 'newer' | 'equal' {
  const storedIso = parseProviderTimestamp(stored);
  const incomingIso = parseProviderTimestamp(incoming);
  if (!incomingIso) {
    return storedIso ? 'older' : 'equal';
  }
  if (!storedIso) {
    return 'newer';
  }
  const storedMs = Date.parse(storedIso);
  const incomingMs = Date.parse(incomingIso);
  if (incomingMs > storedMs) {
    return 'newer';
  }
  if (incomingMs < storedMs) {
    return 'older';
  }
  return 'equal';
}

/** Pure check that a transmission time lies within `maxSkewMs` of `now` (both directions). */
export function isFreshTransmission(
  transmissionTime: string | null | undefined,
  now: Date | number,
  maxSkewMs: number,
): boolean {
  const parsed = parseProviderTimestamp(transmissionTime);
  if (!parsed || typeof maxSkewMs !== 'number' || !Number.isFinite(maxSkewMs) || maxSkewMs < 0) {
    return false;
  }
  const nowMs = typeof now === 'number' ? now : now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(nowMs)) {
    return false;
  }
  return Math.abs(nowMs - Date.parse(parsed)) <= maxSkewMs;
}

export function mapPaypalSubscriptionStatus(status: string): SubscriptionStatus {
  switch (status.toUpperCase()) {
    case 'APPROVAL_PENDING':
      return 'approval_pending';
    case 'APPROVED':
      return 'approved';
    case 'ACTIVE':
      return 'active';
    case 'SUSPENDED':
      return 'suspended';
    case 'CANCELLED':
      return 'cancelled';
    case 'EXPIRED':
      return 'expired';
    default:
      return 'unknown';
  }
}

export function isSubscriptionWebhookProviderRefreshEvent(eventType: string): boolean {
  return eventType === 'BILLING.SUBSCRIPTION.UPDATED';
}

export function mapSubscriptionWebhookEventToStatus(eventType: string): SubscriptionStatus | null {
  switch (eventType) {
    case 'BILLING.SUBSCRIPTION.CREATED':
      return 'approval_pending';
    case 'BILLING.SUBSCRIPTION.ACTIVATED':
    case 'BILLING.SUBSCRIPTION.RE-ACTIVATED':
      return 'active';
    case 'BILLING.SUBSCRIPTION.APPROVED':
      return 'approved';
    case 'BILLING.SUBSCRIPTION.SUSPENDED':
      return 'suspended';
    case 'BILLING.SUBSCRIPTION.CANCELLED':
      return 'cancelled';
    case 'BILLING.SUBSCRIPTION.EXPIRED':
      return 'expired';
    default:
      return null;
  }
}

export const SUBSCRIPTION_PAYMENT_FAILED_EVENT_TYPE = 'BILLING.SUBSCRIPTION.PAYMENT.FAILED';

export const SUBSCRIPTION_SALE_EVENT_TYPES = [
  'PAYMENT.SALE.COMPLETED',
  'PAYMENT.SALE.REFUNDED',
  'PAYMENT.SALE.REVERSED',
] as const;

export function isSubscriptionPaymentEvidenceEvent(eventType: string): boolean {
  return (
    eventType === SUBSCRIPTION_PAYMENT_FAILED_EVENT_TYPE ||
    (SUBSCRIPTION_SALE_EVENT_TYPES as readonly string[]).includes(eventType)
  );
}

/**
 * Whether `current -> next` is allowed: terminal states never move, a
 * subscription past approval never regresses to `approval_pending`, and an
 * active or suspended one never regresses to `approved`.
 */
export function isSubscriptionStatusTransitionAllowed(
  current: SubscriptionStatus,
  next: SubscriptionStatus,
): boolean {
  if (current === next) {
    return true;
  }
  if (SUBSCRIPTION_TERMINAL.has(current)) {
    return false;
  }
  if (next === 'approval_pending' && PAST_APPROVAL.has(current)) {
    return false;
  }
  if (next === 'approved' && PAST_ACTIVATION.has(current)) {
    return false;
  }
  return true;
}

export function isTerminalSubscriptionStatus(status: SubscriptionStatus): boolean {
  return SUBSCRIPTION_TERMINAL.has(status);
}

/** Rejected transitions keep the current subscription status. */
export function resolveSubscriptionStatusTransition(
  current: SubscriptionStatus,
  next: SubscriptionStatus,
): SubscriptionStatus {
  return isSubscriptionStatusTransitionAllowed(current, next) ? next : current;
}

export type SubscriptionStateOrderingDecision =
  | { action: 'apply'; stateAt: string | null }
  | { action: 'noop'; reason: 'stale' | 'equal_conflict' | 'missing_timestamp' };

/**
 * Order an incoming provider state against the stored watermark. Older is a
 * noop; equal with a different status is a noop; a missing timestamp after a
 * watermark is a noop; an unparseable incoming time counts as missing.
 * `authoritative` (provider lookup or our own mutation) always applies and
 * leaves the watermark to the caller.
 */
export function evaluateSubscriptionStateOrdering(input: {
  currentStatus: SubscriptionStatus | null;
  storedStateAt: string | null;
  desiredStatus: SubscriptionStatus;
  incomingStateAt: string | null;
  authoritative: boolean;
}): SubscriptionStateOrderingDecision {
  if (input.authoritative) {
    return { action: 'apply', stateAt: null };
  }

  const incoming = parseProviderTimestamp(input.incomingStateAt);
  if (!incoming) {
    if (input.storedStateAt) {
      return { action: 'noop', reason: 'missing_timestamp' };
    }
    return { action: 'apply', stateAt: null };
  }

  const ordering = compareProviderStateTimestamps(input.storedStateAt, incoming);
  if (ordering === 'older') {
    return { action: 'noop', reason: 'stale' };
  }
  if (ordering === 'equal') {
    const current = input.currentStatus ?? 'approval_pending';
    if (current !== input.desiredStatus) {
      return { action: 'noop', reason: 'equal_conflict' };
    }
  }
  return { action: 'apply', stateAt: incoming };
}
