import {
  PAYMENT_RELIABILITY_ERROR,
  PaymentReliabilityError,
  type ExecuteGetSubscriptionResult,
  type PaymentOperation,
  type PaymentOperationStatus,
  type PlanStatus,
  type SubscriptionStatus,
  type WebhookReceiptResponse,
} from '../../contracts/index';
import {
  SUBSCRIPTION_LOOKUP_EVENT_TYPE,
  SUBSCRIPTION_RECENT_ID_LIMIT,
  type NormalizedSubscriptionEvent,
  type ReduceSubscriptionNoopReason,
  type ReduceSubscriptionOptions,
  type ReduceSubscriptionResult,
  type SubscriptionEffect,
  type SubscriptionLastPayment,
  type SubscriptionMoney,
  type SubscriptionState,
} from '../../subscription-core/lib/subscription-core-types';
import { normalizePaypalSubscriptionEvent } from '../../subscription-core/lib/normalize-paypal-subscription-event';
import { reduceSubscription } from '../../subscription-core/lib/reduce-subscription';
import {
  planStatusToOperationStatus,
  readSubscriptionProviderStateWatermark,
  resolveProviderTransactionIdAfterSubscriptionStateWatermarkPersist,
  resolveSubscriptionStatusTransition,
  subscriptionStatusToOperationStatus,
  type SubscriptionStateApplySource,
} from './subscription-transition-policy';
import type { OperationStore } from './persistence/payment-reliability-store';
import { assertTransitionAllowed } from './transition-policy';
import { clearResolvedOperationRetryState } from './retry-backoff';

const SUBSCRIPTION_TRANSITION_MAX_VERSION_RETRIES = 8;

function resolveExecutionTransition(
  currentStatus: PaymentOperationStatus,
  desiredStatus: PaymentOperationStatus,
): PaymentOperationStatus {
  if (desiredStatus === currentStatus) {
    return currentStatus;
  }

  try {
    assertTransitionAllowed(currentStatus, desiredStatus);
    return desiredStatus;
  } catch (error) {
    if (
      error instanceof PaymentReliabilityError &&
      error.code === PAYMENT_RELIABILITY_ERROR.TRANSITION_REJECTED
    ) {
      return currentStatus;
    }
    throw error;
  }
}

function isTransitionVersionConflict(error: unknown): boolean {
  return (
    error instanceof PaymentReliabilityError &&
    error.code === PAYMENT_RELIABILITY_ERROR.TRANSITION_CONFLICT
  );
}

async function persistDomainAwareOperationUpdate(
  store: OperationStore,
  operation: PaymentOperation,
  input: {
    nextExecution: PaymentOperationStatus;
    reason: string;
    evidenceId?: string | null;
    providerReferenceId?: string | null;
    providerSubscriptionId?: string | null;
    providerPlanId?: string | null;
    approvalUrl?: string | null;
    startTime?: string | null;
    nextBillingTime?: string | null;
    lifecycleReason?: string | null;
    planStatus?: PlanStatus;
    subscriptionStatus?: SubscriptionStatus;
    providerStateWatermark?: string;
  },
): Promise<PaymentOperation> {
  const subscriptionStatus =
    input.subscriptionStatus !== undefined
      ? resolveSubscriptionStatusTransition(
          operation.subscriptionStatus ?? 'approval_pending',
          input.subscriptionStatus,
        )
      : undefined;

  const providerSubscriptionStateAt = input.providerStateWatermark;
  const providerTransactionId =
    input.providerStateWatermark !== undefined
      ? resolveProviderTransactionIdAfterSubscriptionStateWatermarkPersist(operation)
      : undefined;
  const watermarkChanged =
    providerSubscriptionStateAt !== undefined &&
    providerSubscriptionStateAt !== operation.providerSubscriptionStateAt;
  const providerTransactionIdChanged =
    providerTransactionId !== undefined &&
    providerTransactionId !== operation.providerTransactionId;

  const domainChanged =
    (input.planStatus !== undefined && input.planStatus !== operation.planStatus) ||
    (subscriptionStatus !== undefined && subscriptionStatus !== operation.subscriptionStatus) ||
    watermarkChanged ||
    providerTransactionIdChanged;

  if (input.nextExecution === operation.status) {
    if (!domainChanged) {
      return operation;
    }

    return store.updateOperation({
      operationId: operation.operationId,
      expectedVersion: operation.version,
      planStatus: input.planStatus,
      subscriptionStatus,
      providerSubscriptionStateAt,
      providerTransactionId,
      providerReferenceId: input.providerReferenceId ?? undefined,
      providerSubscriptionId: input.providerSubscriptionId ?? undefined,
      providerPlanId: input.providerPlanId ?? undefined,
      approvalUrl: input.approvalUrl ?? undefined,
      startTime: input.startTime ?? undefined,
      nextBillingTime: input.nextBillingTime ?? undefined,
      lifecycleReason: input.lifecycleReason ?? undefined,
    });
  }

  return store.transitionOperation({
    operationId: operation.operationId,
    expectedVersion: operation.version,
    nextStatus: input.nextExecution,
    planStatus: input.planStatus,
    subscriptionStatus,
    providerSubscriptionStateAt,
    providerTransactionId,
    providerReferenceId: input.providerReferenceId ?? operation.providerReferenceId,
    providerSubscriptionId: input.providerSubscriptionId ?? undefined,
    providerPlanId: input.providerPlanId ?? undefined,
    approvalUrl: input.approvalUrl ?? undefined,
    startTime: input.startTime ?? undefined,
    nextBillingTime: input.nextBillingTime ?? undefined,
    lifecycleReason: input.lifecycleReason ?? undefined,
    evidenceId: input.evidenceId ?? null,
    reason: input.reason,
  });
}

export type ApplySubscriptionTransitionInput = {
  operation: PaymentOperation;
  subscriptionStatus: SubscriptionStatus;
  evidenceId?: string | null;
  reason: string;
  providerReferenceId?: string | null;
  providerSubscriptionId?: string | null;
  providerPlanId?: string | null;
  approvalUrl?: string | null;
  startTime?: string | null;
  nextBillingTime?: string | null;
  lifecycleReason?: string | null;
  providerStateTimestamp?: string | null;
  applySource?: SubscriptionStateApplySource;
};

export type ApplyPlanTransitionInput = {
  operation: PaymentOperation;
  planStatus: PlanStatus;
  evidenceId?: string | null;
  reason: string;
  providerReferenceId?: string | null;
  providerPlanId?: string | null;
};

/** Event type of a status change the engine applies without a provider event (`applySubscriptionTransition`). */
const ENGINE_TRANSITION_EVENT_TYPE = 'engine.subscription.transition';

/**
 * How many undelivered effect batches `subscriptionStateJson` holds. Batches are never evicted: a
 * row that would need one more is left `pending` with `HELD_EFFECTS_OVERFLOW` and applied later.
 */
const MAX_PENDING_EFFECT_BATCHES = 16;

/** How many rows with a reported plan mismatch a subscription remembers (oldest dropped first). */
const MAX_PLAN_MISMATCH_ROWS = 32;

/** Version of the `subscriptionStateJson` layout this package reads and writes. */
const SUBSCRIPTION_STATE_VERSION = 1;

/** Code stored on evidence whose state was saved but whose host hook threw; the row stays retryable. */
export const SUBSCRIPTION_EFFECTS_HOOK_FAILED =
  PAYMENT_RELIABILITY_ERROR.SUBSCRIPTION_EFFECTS_HOOK_FAILED;

/**
 * Code on evidence that was not applied because the subscription already holds the maximum number
 * of undelivered effect batches (the hook has been failing). The row stays `pending` and is applied
 * once the hook accepts the held batches.
 */
export const HELD_EFFECTS_OVERFLOW = 'HELD_EFFECTS_OVERFLOW';

/**
 * Code on evidence whose held effects could not be delivered because the processing service has no
 * `onSubscriptionEffects` hook (give `WebhookProcessingService` the same hook as reconciliation).
 */
export const SUBSCRIPTION_EFFECTS_HOOK_MISSING = 'SUBSCRIPTION_EFFECTS_HOOK_MISSING';

/**
 * Code on webhook evidence whose status conflicts with the stored one at the same provider state
 * time (PayPal times have second precision). The row is left `unmatched` (a reconciliation
 * candidate, retried by recovery) until a provider lookup settles the status.
 */
export const SUBSCRIPTION_STATE_CONFLICT_EQUAL_TIMESTAMP =
  'SUBSCRIPTION_STATE_CONFLICT_EQUAL_TIMESTAMP';

export type SubscriptionEffectsContext = {
  /** Evidence row the effects come from; null for a lifecycle command (`cancelSubscription`, ...). */
  evidenceId: string | null;
  eventType: string;
  source: 'webhook' | 'reconciliation' | 'lifecycle';
  /** `applied` when at least one event changed or confirmed the state. */
  decision: 'applied' | 'noop';
  /** Why nothing applied (`plan_mismatch`, `amount_mismatch`, ...); null when applied. */
  reason: ReduceSubscriptionNoopReason | null;
  /** The subscription operation after the state was persisted. */
  operation: PaymentOperation;
};

/**
 * Host hook for the reducer's effects, called after the state is persisted. The package puts no
 * business logic here. Delivery is at least once per evidence row (or lifecycle command):
 * - effects of a state change are held in `subscriptionStateJson` until the hook returns; if it
 *   throws, the row stays `pending` (`SUBSCRIPTION_EFFECTS_HOOK_FAILED`) and the same batch is
 *   delivered again when the row is reprocessed;
 * - effects of a row that changed nothing (`amount_mismatch`, `currency_mismatch`) are recomputed and
 *   delivered again on every reprocessing until a delivery succeeds;
 * - a `plan_mismatch` that keeps a row `pending` is delivered once per row (the last 32 such rows
 *   per subscription are remembered), not on every recovery run.
 * Make the hook idempotent (for example on `context.evidenceId` and the effect).
 */
export type SubscriptionEffectsHook = (
  operationId: string,
  effects: SubscriptionEffect[],
  context: SubscriptionEffectsContext,
) => void | Promise<void>;

export type SubscriptionEffectsHooks = {
  onSubscriptionEffects?: SubscriptionEffectsHook;
};

type PendingSubscriptionEffects = { key: string; effects: SubscriptionEffect[] };

type PlanMismatchRow = { key: string; evidenceId: string | null; notified: boolean };

/** `subscriptionStateJson` (version 1): the reducer state without a column of its own. */
type StoredSubscriptionState = {
  lastPayment: SubscriptionLastPayment | null;
  failedPaymentsCount: number | null;
  lastEventId: string | null;
  recentEventIds: string[];
  recentSaleIds: string[];
  pendingEffects: PendingSubscriptionEffects[];
  planMismatches: PlanMismatchRow[];
  /** Fields this version does not know; written back unchanged. */
  extra: Record<string, unknown>;
};

const KNOWN_STATE_FIELDS: ReadonlySet<string> = new Set([
  'version',
  'lastPayment',
  'failedPaymentsCount',
  'lastEventId',
  'recentEventIds',
  'recentSaleIds',
  'pendingEffects',
  'planMismatches',
]);

function emptyStoredState(): StoredSubscriptionState {
  return {
    lastPayment: null,
    failedPaymentsCount: null,
    lastEventId: null,
    recentEventIds: [],
    recentSaleIds: [],
    pendingEffects: [],
    planMismatches: [],
    extra: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unreadableState(detail: string): PaymentReliabilityError {
  return new PaymentReliabilityError(
    PAYMENT_RELIABILITY_ERROR.SUBSCRIPTION_STATE_UNREADABLE,
    `Stored subscription state cannot be read: ${detail}`,
  );
}

function readStringList(value: unknown, field: string, limit: number): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw unreadableState(field);
  }
  return value.slice(-limit);
}

function readOptionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw unreadableState(field);
  }
  return value;
}

function readStoredLastPayment(value: unknown): SubscriptionLastPayment | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (
    !isRecord(value) ||
    typeof value.amountMinor !== 'string' ||
    typeof value.currency !== 'string' ||
    (value.time !== null && typeof value.time !== 'string')
  ) {
    throw unreadableState('lastPayment');
  }
  return { amountMinor: value.amountMinor, currency: value.currency, time: value.time };
}

function readFailedPaymentsCount(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw unreadableState('failedPaymentsCount');
  }
  return value;
}

function readPendingEffects(value: unknown): PendingSubscriptionEffects[] {
  if (value === undefined || value === null) {
    return [];
  }
  const valid =
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.key === 'string' &&
        Array.isArray(entry.effects) &&
        entry.effects.every((effect) => isRecord(effect) && typeof effect.type === 'string'),
    );
  if (!valid) {
    throw unreadableState('pendingEffects');
  }
  return value as PendingSubscriptionEffects[];
}

function readPlanMismatches(value: unknown): PlanMismatchRow[] {
  if (value === undefined || value === null) {
    return [];
  }
  const valid =
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.key === 'string' &&
        (entry.evidenceId === null || typeof entry.evidenceId === 'string') &&
        typeof entry.notified === 'boolean',
    );
  if (!valid) {
    throw unreadableState('planMismatches');
  }
  return (value as PlanMismatchRow[]).slice(-MAX_PLAN_MISMATCH_ROWS);
}

/**
 * Reads `subscriptionStateJson` as written (text) or as returned by a `jsonb` column (object).
 * Fails closed: unreadable content throws `SUBSCRIPTION_STATE_UNREADABLE` and a layout newer than
 * this package throws `SUBSCRIPTION_STATE_VERSION_UNSUPPORTED`; it is never treated as "no state".
 */
function parseStoredSubscriptionState(value: unknown): StoredSubscriptionState {
  if (value === undefined || value === null || value === '') {
    return emptyStoredState();
  }
  let source: unknown = value;
  if (typeof value === 'string') {
    try {
      source = JSON.parse(value);
    } catch {
      throw unreadableState('not JSON');
    }
  }
  if (!isRecord(source)) {
    throw unreadableState('not an object');
  }
  const version = source.version;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw unreadableState('version');
  }
  if (version > SUBSCRIPTION_STATE_VERSION) {
    throw new PaymentReliabilityError(
      PAYMENT_RELIABILITY_ERROR.SUBSCRIPTION_STATE_VERSION_UNSUPPORTED,
      `Stored subscription state version ${version} is newer than this package supports`,
    );
  }
  return {
    lastPayment: readStoredLastPayment(source.lastPayment),
    failedPaymentsCount: readFailedPaymentsCount(source.failedPaymentsCount),
    lastEventId: readOptionalString(source.lastEventId, 'lastEventId'),
    recentEventIds: readStringList(
      source.recentEventIds,
      'recentEventIds',
      SUBSCRIPTION_RECENT_ID_LIMIT,
    ),
    recentSaleIds: readStringList(
      source.recentSaleIds,
      'recentSaleIds',
      SUBSCRIPTION_RECENT_ID_LIMIT,
    ),
    pendingEffects: readPendingEffects(source.pendingEffects),
    planMismatches: readPlanMismatches(source.planMismatches),
    extra: Object.fromEntries(
      Object.entries(source).filter(([key]) => !KNOWN_STATE_FIELDS.has(key)),
    ),
  };
}

function serializeSubscriptionState(
  state: SubscriptionState,
  stored: StoredSubscriptionState,
): string {
  return JSON.stringify({
    ...stored.extra,
    version: SUBSCRIPTION_STATE_VERSION,
    lastPayment: state.lastPayment,
    failedPaymentsCount: state.failedPaymentsCount,
    lastEventId: state.lastEventId,
    recentEventIds: state.recentEventIds,
    recentSaleIds: state.recentSaleIds,
    pendingEffects: stored.pendingEffects,
    planMismatches: stored.planMismatches,
  });
}

function readSubscriptionStateFrom(
  operation: PaymentOperation,
  stored: StoredSubscriptionState,
): SubscriptionState {
  return {
    status: operation.subscriptionStatus ?? 'approval_pending',
    providerSubscriptionId: operation.providerSubscriptionId ?? null,
    providerPlanId: operation.providerPlanId ?? null,
    stateAt: readSubscriptionProviderStateWatermark(operation),
    nextBillingTime: operation.nextBillingTime ?? null,
    startTime: operation.startTime ?? null,
    lastPayment: stored.lastPayment,
    failedPaymentsCount: stored.failedPaymentsCount,
    lastEventId: stored.lastEventId,
    recentEventIds: stored.recentEventIds,
    recentSaleIds: stored.recentSaleIds,
  };
}

/**
 * The `SubscriptionState` of a subscription operation: its columns (status, ids, watermark,
 * billing dates) plus `subscriptionStateJson` (last payment, failed-payment count, recent ids).
 * This is the state the engine feeds into `reduceSubscription`; hosts use it to read the last
 * payment and the failed-payment count. Throws `SUBSCRIPTION_STATE_UNREADABLE` or
 * `SUBSCRIPTION_STATE_VERSION_UNSUPPORTED` instead of returning a state that lost data.
 */
export function readSubscriptionOperationState(operation: PaymentOperation): SubscriptionState {
  return readSubscriptionStateFrom(
    operation,
    parseStoredSubscriptionState(operation.subscriptionStateJson),
  );
}

/**
 * Normalise a stored webhook body for the reducer. A body without its own `id` (accepted at intake
 * with a host-supplied event id) is read with the evidence's provider event id.
 */
export function normalizeSubscriptionEvidencePayload(
  rawPayload: string | null | undefined,
  providerEventId: string | null,
): NormalizedSubscriptionEvent | null {
  const raw = rawPayload ?? '';
  const result = normalizePaypalSubscriptionEvent(raw);
  if (result.ok) {
    return result.event;
  }
  if (result.reason !== 'missing_event_id' || !providerEventId) {
    return null;
  }
  try {
    const body: unknown = JSON.parse(raw);
    if (!isRecord(body) || Object.prototype.hasOwnProperty.call(body, 'id')) {
      return null;
    }
    const withId = normalizePaypalSubscriptionEvent(
      JSON.stringify({ ...body, id: providerEventId }),
    );
    return withId.ok ? withId.event : null;
  } catch {
    return null;
  }
}

/**
 * A provider lookup (GET subscription) as a reducer event. `stateAt` is the snapshot's state time;
 * `fallbackStatus` is used when the snapshot status is unknown.
 */
export function subscriptionEventFromProviderSnapshot(
  providerSubscriptionId: string,
  snapshot: Pick<ExecuteGetSubscriptionResult, 'providerPlanId' | 'subscriptionStatus'> &
    Partial<ExecuteGetSubscriptionResult>,
  input: {
    providerEventId?: string | null;
    eventType?: string;
    fallbackStatus?: SubscriptionStatus | null;
  } = {},
): NormalizedSubscriptionEvent {
  const status =
    snapshot.subscriptionStatus && snapshot.subscriptionStatus !== 'unknown'
      ? snapshot.subscriptionStatus
      : (input.fallbackStatus ?? null);
  const nonEmpty = (value: string | null | undefined) =>
    value != null && value.trim().length > 0 ? value : null;
  return {
    providerEventId: input.providerEventId ?? null,
    eventType: input.eventType ?? SUBSCRIPTION_LOOKUP_EVENT_TYPE,
    resourceType: 'subscription',
    providerSubscriptionId,
    providerPlanId: nonEmpty(snapshot.providerPlanId)?.trim() ?? null,
    providerStatus: null,
    subscriptionStatus: status,
    stateAt: nonEmpty(snapshot.providerSubscriptionStateAt),
    nextBillingTime: nonEmpty(snapshot.nextBillingTime),
    startTime: nonEmpty(snapshot.startTime),
    lastPayment: snapshot.lastPayment ?? null,
    failedPaymentsCount: snapshot.failedPaymentsCount ?? null,
    outstandingBalance: snapshot.outstandingBalance ?? null,
    payment: null,
    eventTime: null,
  };
}

/**
 * Expected price of one billing cycle: the subscription's own `amountMinor`/`currencyCode` when a
 * host set them, else those of its parent billing plan (stored by `createBillingPlan`). Null when
 * no price is known: then only the plan id is checked. The plan amount is the lowest paid cycle or
 * setup fee, so a priced trial weakens underpayment detection, and a price lowered at PayPal makes
 * renewals `amount_mismatch` until the host stores the new amount (`adoptSubscriptionPlan`).
 */
export async function resolveExpectedSubscriptionPayment(
  store: Pick<OperationStore, 'findOperationById'>,
  operation: PaymentOperation,
): Promise<SubscriptionMoney | null> {
  if (operation.amountMinor && operation.currencyCode) {
    return { amountMinor: operation.amountMinor, currency: operation.currencyCode };
  }
  if (!operation.parentOperationId) {
    return null;
  }
  const plan = await store.findOperationById(operation.parentOperationId);
  if (plan?.kind !== 'billing_plan' || !plan.amountMinor || !plan.currencyCode) {
    return null;
  }
  return { amountMinor: plan.amountMinor, currency: plan.currencyCode };
}

export type SubscriptionEventStep = {
  event: NormalizedSubscriptionEvent;
  options: ReduceSubscriptionOptions;
  /**
   * The event is a fresh provider snapshot ordered as a webhook: when the pure rule finds the same
   * state time with another status (`equal_conflict`), the snapshot is applied as `source: 'lookup'`
   * (it is the provider's current truth). The reducer itself keeps the rule.
   */
  lookupOnEqualConflict?: boolean;
};

export type ApplySubscriptionEventsInput = {
  operation: PaymentOperation;
  /** Reduced in order against the stored state, then persisted with one write. */
  steps: SubscriptionEventStep[];
  evidenceId: string | null;
  /** Key the effects are held under; defaults to `evidenceId` (lifecycle commands: `command:<id>`). */
  effectsKey?: string | null;
  /** Key a reported plan mismatch is remembered under; defaults to `effectsKey`. */
  planMismatchKey?: string | null;
  reason: string;
  /** Keep the effects in `subscriptionStateJson` until the hook accepted them (a hook is set). */
  holdEffects?: boolean;
  approvalUrl?: string | null;
  lifecycleReason?: string | null;
};

export type ApplySubscriptionEventsResult = {
  operation: PaymentOperation;
  decision: 'applied' | 'noop';
  reason: ReduceSubscriptionNoopReason | null;
  /** A plan mismatch kept the subscription from (staying) active: nothing was applied. */
  planMismatch: boolean;
  /** Effects to hand to the host: this run's, plus any held from an earlier failed delivery. */
  effects: SubscriptionEffect[];
  /** Key the effects are held under (null when they are not held). */
  heldKey: string | null;
  /** A plan mismatch first reported now: remembered once the hook accepted it. */
  planMismatchToNotify: PlanMismatchRow | null;
  /** Nothing was applied: the subscription already holds the maximum of undelivered batches. */
  heldOverflow: boolean;
  /**
   * Nothing was applied because the event has the stored state time but another status
   * (`equal_conflict`, second precision at PayPal). Only a provider lookup can settle it.
   */
  equalTimestampConflict: boolean;
};

/** Noop reasons after which the execution status is still synced to the stored subscription status. */
const SYNC_EXECUTION_ON_NOOP: ReadonlySet<ReduceSubscriptionNoopReason> = new Set([
  'transition_rejected',
  'duplicate_event',
]);

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasMaterialChange(before: SubscriptionState, after: SubscriptionState): boolean {
  return (
    before.status !== after.status ||
    before.providerSubscriptionId !== after.providerSubscriptionId ||
    before.providerPlanId !== after.providerPlanId ||
    before.stateAt !== after.stateAt ||
    before.nextBillingTime !== after.nextBillingTime ||
    before.startTime !== after.startTime ||
    before.failedPaymentsCount !== after.failedPaymentsCount ||
    !sameJson(before.lastPayment, after.lastPayment) ||
    !sameJson(before.recentSaleIds, after.recentSaleIds)
  );
}

type ReducedSteps = {
  state: SubscriptionState;
  applied: boolean;
  reason: ReduceSubscriptionNoopReason | null;
  planMismatch: boolean;
  equalConflict: boolean;
  effects: SubscriptionEffect[];
};

function isEqualConflict(result: ReduceSubscriptionResult): boolean {
  const noopReason = result.decision === 'noop' ? result.reason : null;
  return noopReason === 'equal_conflict';
}

function reduceSteps(before: SubscriptionState, steps: SubscriptionEventStep[]): ReducedSteps {
  const reduced: ReducedSteps = {
    state: before,
    applied: false,
    reason: null,
    planMismatch: false,
    equalConflict: false,
    effects: [],
  };
  for (const step of steps) {
    let result = reduceSubscription(reduced.state, step.event, step.options);
    if (step.lookupOnEqualConflict && isEqualConflict(result)) {
      result = reduceSubscription(reduced.state, step.event, { ...step.options, source: 'lookup' });
    }
    reduced.effects.push(...result.effects);
    if (result.decision === 'applied') {
      reduced.state = result.state;
      reduced.applied = true;
    } else {
      // A reducer noop reason (typed), not a free-text transition reason.
      const noopReason = result.reason;
      reduced.reason ??= noopReason;
      reduced.planMismatch ||= noopReason === 'plan_mismatch';
      reduced.equalConflict ||= noopReason === 'equal_conflict';
    }
  }
  if (!reduced.state.providerSubscriptionId) {
    // An engine transition without any id must not store an empty one.
    reduced.state = { ...reduced.state, providerSubscriptionId: before.providerSubscriptionId };
  }
  return reduced;
}

async function applySubscriptionEventsOnce(
  store: OperationStore,
  input: ApplySubscriptionEventsInput,
): Promise<ApplySubscriptionEventsResult> {
  const { operation } = input;
  const stored = parseStoredSubscriptionState(operation.subscriptionStateJson);
  const before = readSubscriptionStateFrom(operation, stored);
  const reduced = reduceSteps(before, input.steps);
  const { state, applied } = reduced;
  const planMismatch = !applied && reduced.planMismatch;
  const effectsKey = input.effectsKey ?? input.evidenceId;
  const mismatchKey = input.planMismatchKey ?? effectsKey;

  const held = effectsKey
    ? stored.pendingEffects.find((entry) => entry.key === effectsKey)
    : undefined;
  let effects = held
    ? [
        ...held.effects,
        ...reduced.effects.filter((effect) => !held.effects.some((h) => sameJson(h, effect))),
      ]
    : reduced.effects;

  // A plan mismatch that keeps a row pending is reported once per row, not on every retry: it is
  // remembered after the hook accepted it (nothing else is written for such a row).
  let planMismatchToNotify: PlanMismatchRow | null = null;
  if (planMismatch && mismatchKey && input.holdEffects) {
    if (stored.planMismatches.some((row) => row.key === mismatchKey && row.notified)) {
      effects = held ? held.effects : [];
    } else {
      planMismatchToNotify = {
        key: mismatchKey,
        // Only webhook rows can be reprocessed after a plan adoption.
        evidenceId: mismatchKey === input.evidenceId ? input.evidenceId : null,
        notified: true,
      };
    }
  }

  const syncExecution =
    !reduced.planMismatch &&
    (applied || (reduced.reason !== null && SYNC_EXECUTION_ON_NOOP.has(reduced.reason)));
  const nextExecution = syncExecution
    ? resolveExecutionTransition(
        operation.status,
        subscriptionStatusToOperationStatus(state.status),
      )
    : operation.status;
  const stateChanged = hasMaterialChange(before, state);
  const holdNow = Boolean(input.holdEffects && effectsKey && effects.length > 0 && stateChanged);
  const otherHeld = stored.pendingEffects.filter((entry) => entry.key !== effectsKey);
  const result = {
    decision: applied ? ('applied' as const) : ('noop' as const),
    reason: applied ? null : reduced.reason,
    planMismatch,
    effects,
    heldKey: holdNow || held ? (effectsKey ?? null) : null,
    planMismatchToNotify,
    heldOverflow: false,
    equalTimestampConflict: !applied && reduced.equalConflict,
  };
  if (holdNow && otherHeld.length >= MAX_PENDING_EFFECT_BATCHES) {
    // Never evict a held batch: leave this event unapplied until the hook drains the backlog.
    return { ...result, effects: [], heldKey: null, heldOverflow: true, operation };
  }

  const pendingEffects =
    holdNow && effectsKey ? [...otherHeld, { key: effectsKey, effects }] : stored.pendingEffects;
  const storedChanged = stateChanged;
  const extrasChanged =
    (input.approvalUrl != null && input.approvalUrl !== operation.approvalUrl) ||
    (input.lifecycleReason != null && input.lifecycleReason !== operation.lifecycleReason);
  if (!storedChanged && !extrasChanged && nextExecution === operation.status) {
    return { ...result, operation };
  }

  const watermarkChanged = state.stateAt !== before.stateAt;
  const isSubscriptionKind = operation.kind === 'subscription';
  const patch = {
    subscriptionStatus: state.status !== before.status ? state.status : undefined,
    providerPlanId:
      state.providerPlanId !== before.providerPlanId ? state.providerPlanId : undefined,
    // Ids are only ever filled in, never replaced (a sale or payment id is never a subscription id).
    providerSubscriptionId:
      !operation.providerSubscriptionId && state.providerSubscriptionId
        ? state.providerSubscriptionId
        : undefined,
    providerReferenceId:
      isSubscriptionKind && !operation.providerReferenceId && state.providerSubscriptionId
        ? state.providerSubscriptionId
        : undefined,
    providerSubscriptionStateAt: watermarkChanged ? state.stateAt : undefined,
    providerTransactionId: watermarkChanged
      ? resolveProviderTransactionIdAfterSubscriptionStateWatermarkPersist(operation)
      : undefined,
    nextBillingTime:
      state.nextBillingTime !== before.nextBillingTime ? state.nextBillingTime : undefined,
    startTime: state.startTime !== before.startTime ? state.startTime : undefined,
    approvalUrl: input.approvalUrl ?? undefined,
    lifecycleReason: input.lifecycleReason ?? undefined,
    subscriptionStateJson: storedChanged
      ? serializeSubscriptionState(state, { ...stored, pendingEffects })
      : undefined,
  };

  const persisted =
    nextExecution === operation.status
      ? await store.updateOperation({
          operationId: operation.operationId,
          expectedVersion: operation.version,
          ...patch,
        })
      : await store.transitionOperation({
          operationId: operation.operationId,
          expectedVersion: operation.version,
          nextStatus: nextExecution,
          ...patch,
          evidenceId: input.evidenceId,
          reason: input.reason,
        });
  return { ...result, operation: persisted };
}

/**
 * Run events through the pure reducer (`reduceSubscription`) against the operation's stored state
 * and persist the result: status (and the execution status it implies), plan, watermark, billing
 * dates and `subscriptionStateJson`. The single place where the engine changes subscription state
 * from provider evidence and lifecycle commands. Retries on a version conflict with the fresh row.
 * Writes nothing when only the recent event ids would change (evidence rows are unique per provider
 * event already). Throws `SUBSCRIPTION_STATE_UNREADABLE` / `SUBSCRIPTION_STATE_VERSION_UNSUPPORTED`
 * without writing when the stored state cannot be read.
 */
export async function applySubscriptionEvents(
  store: OperationStore,
  input: ApplySubscriptionEventsInput,
): Promise<ApplySubscriptionEventsResult> {
  let operation = input.operation;
  for (let attempt = 0; attempt < SUBSCRIPTION_TRANSITION_MAX_VERSION_RETRIES; attempt += 1) {
    try {
      const applied = await applySubscriptionEventsOnce(store, { ...input, operation });
      return {
        ...applied,
        operation: await clearResolvedOperationRetryState(store, applied.operation),
      };
    } catch (error) {
      if (!isTransitionVersionConflict(error)) {
        throw error;
      }
      const fresh = await store.findOperationById(operation.operationId);
      if (!fresh) {
        throw error;
      }
      operation = fresh;
    }
  }
  throw new PaymentReliabilityError(
    PAYMENT_RELIABILITY_ERROR.TRANSITION_CONFLICT,
    'Subscription state kept changing while it was applied',
  );
}

/** Effects held on a subscription operation under `key` (an earlier hook call failed). */
export function readHeldSubscriptionEffects(
  operation: PaymentOperation,
  key: string,
): SubscriptionEffect[] {
  return (
    parseStoredSubscriptionState(operation.subscriptionStateJson).pendingEffects.find(
      (entry) => entry.key === key,
    )?.effects ?? []
  );
}

/** Compare-and-set rewrite of the stored state only (retried on version conflicts). */
async function updateStoredSubscriptionState(
  store: OperationStore,
  operationId: string,
  change: (stored: StoredSubscriptionState) => StoredSubscriptionState | null,
): Promise<void> {
  for (let attempt = 0; attempt < SUBSCRIPTION_TRANSITION_MAX_VERSION_RETRIES; attempt += 1) {
    const operation = await store.findOperationById(operationId);
    if (!operation) {
      return;
    }
    const stored = parseStoredSubscriptionState(operation.subscriptionStateJson);
    const next = change(stored);
    if (!next) {
      return;
    }
    try {
      await store.updateOperation({
        operationId,
        expectedVersion: operation.version,
        subscriptionStateJson: serializeSubscriptionState(
          readSubscriptionStateFrom(operation, stored),
          next,
        ),
      });
      return;
    } catch (error) {
      if (!isTransitionVersionConflict(error)) {
        throw error;
      }
    }
  }
}

/** Drop the effects held under `key` once the host hook accepted them. */
export async function clearPendingSubscriptionEffects(
  store: OperationStore,
  operationId: string,
  key: string,
): Promise<void> {
  await updateStoredSubscriptionState(store, operationId, (stored) =>
    stored.pendingEffects.some((entry) => entry.key === key)
      ? { ...stored, pendingEffects: stored.pendingEffects.filter((entry) => entry.key !== key) }
      : null,
  );
}

async function markPlanMismatchNotified(
  store: OperationStore,
  operationId: string,
  notified: PlanMismatchRow,
): Promise<void> {
  await updateStoredSubscriptionState(store, operationId, (stored) =>
    stored.planMismatches.some((row) => row.key === notified.key && row.notified)
      ? null
      : {
          ...stored,
          planMismatches: [
            ...stored.planMismatches.filter((row) => row.key !== notified.key),
            notified,
          ].slice(-MAX_PLAN_MISMATCH_ROWS),
        },
  );
}

export type SubscriptionEffectsDelivery =
  | { delivered: true }
  | {
      delivered: false;
      /** `SUBSCRIPTION_EFFECTS_HOOK_FAILED`, `SUBSCRIPTION_EFFECTS_HOOK_MISSING` or `HELD_EFFECTS_OVERFLOW`. */
      code: string;
      error?: unknown;
    };

/**
 * Hand the effects to the host hook (after the state was persisted) and release them once it
 * returns. Never reports success for effects that were not delivered: held effects without a hook
 * are `SUBSCRIPTION_EFFECTS_HOOK_MISSING`, an unapplied event over the hold limit is
 * `HELD_EFFECTS_OVERFLOW`. Returns the hook's error instead of throwing, so the caller can keep its
 * evidence row retryable.
 */
export async function deliverSubscriptionEffects(
  store: OperationStore,
  hooks: SubscriptionEffectsHooks,
  applied: ApplySubscriptionEventsResult,
  context: Omit<SubscriptionEffectsContext, 'decision' | 'reason' | 'operation'>,
): Promise<SubscriptionEffectsDelivery> {
  if (applied.heldOverflow) {
    return { delivered: false, code: HELD_EFFECTS_OVERFLOW };
  }
  const hook = hooks.onSubscriptionEffects;
  if (applied.effects.length === 0) {
    return { delivered: true };
  }
  if (!hook) {
    return applied.heldKey
      ? { delivered: false, code: SUBSCRIPTION_EFFECTS_HOOK_MISSING }
      : { delivered: true };
  }
  try {
    await hook(applied.operation.operationId, applied.effects, {
      ...context,
      decision: applied.decision,
      reason: applied.reason,
      operation: applied.operation,
    });
  } catch (error) {
    return { delivered: false, code: SUBSCRIPTION_EFFECTS_HOOK_FAILED, error };
  }
  if (applied.heldKey) {
    await clearPendingSubscriptionEffects(store, applied.operation.operationId, applied.heldKey);
  }
  if (applied.planMismatchToNotify) {
    await markPlanMismatchNotified(
      store,
      applied.operation.operationId,
      applied.planMismatchToNotify,
    );
  }
  return { delivered: true };
}

/** Anything that can reprocess a stored evidence row (`WebhookProcessingService`). */
export type StoredEvidenceReprocessor = {
  reprocessStoredWebhookEvidence(evidenceId: string): Promise<WebhookReceiptResponse>;
};

export type AdoptSubscriptionPlanInput = {
  store: OperationStore;
  /** The `subscription` operation whose plan changed at PayPal (revise, or a new plan you accept). */
  operationId: string;
  providerPlanId: string;
  /** Expected price of one billing cycle on the new plan; `undefined` keeps, `null` clears. */
  amountMinor?: string | null;
  currencyCode?: string | null;
  /** When given, the rows left `pending` by the old plan check are reprocessed right away. */
  webhookProcessing?: StoredEvidenceReprocessor;
};

export type AdoptSubscriptionPlanResult = {
  operation: PaymentOperation;
  /** Rows the engine had left `pending` with `SUBSCRIPTION_PLAN_MISMATCH` for this subscription. */
  pendingEvidenceIds: string[];
  /** Receipts of the rows reprocessed through `webhookProcessing` (empty without it). */
  reprocessed: WebhookReceiptResponse[];
};

/**
 * Accept a new plan for a subscription (plan revision at PayPal, or a host decision): one
 * compare-and-set write of `providerPlanId` (and the expected price) on the subscription operation,
 * which also forgets the plan mismatches reported so far. Rows left `pending` with
 * `SUBSCRIPTION_PLAN_MISMATCH` then apply on their next processing: pass `webhookProcessing` to
 * reprocess the remembered rows now, otherwise `PaymentRecoveryService` picks them up (they are
 * `pending`). Only the subscription operation is changed; the host owns any product consequence.
 */
export async function adoptSubscriptionPlan(
  input: AdoptSubscriptionPlanInput,
): Promise<AdoptSubscriptionPlanResult> {
  const providerPlanId = input.providerPlanId.trim();
  if (!providerPlanId) {
    throw new PaymentReliabilityError(
      PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
      'providerPlanId is required to adopt a subscription plan',
    );
  }
  for (let attempt = 0; attempt < SUBSCRIPTION_TRANSITION_MAX_VERSION_RETRIES; attempt += 1) {
    const operation = await input.store.findOperationById(input.operationId);
    if (!operation || operation.kind !== 'subscription') {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Subscription operation was not found',
      );
    }
    const stored = parseStoredSubscriptionState(operation.subscriptionStateJson);
    const pendingEvidenceIds = stored.planMismatches.flatMap((row) =>
      row.evidenceId ? [row.evidenceId] : [],
    );
    let updated: PaymentOperation;
    try {
      updated = await input.store.updateOperation({
        operationId: operation.operationId,
        expectedVersion: operation.version,
        providerPlanId,
        amountMinor: input.amountMinor,
        currencyCode: input.currencyCode,
        subscriptionStateJson:
          stored.planMismatches.length > 0
            ? serializeSubscriptionState(readSubscriptionStateFrom(operation, stored), {
                ...stored,
                planMismatches: [],
              })
            : undefined,
      });
    } catch (error) {
      if (isTransitionVersionConflict(error)) {
        continue;
      }
      throw error;
    }
    const reprocessed: WebhookReceiptResponse[] = [];
    if (input.webhookProcessing) {
      for (const evidenceId of pendingEvidenceIds) {
        reprocessed.push(await input.webhookProcessing.reprocessStoredWebhookEvidence(evidenceId));
      }
    }
    return { operation: updated, pendingEvidenceIds, reprocessed };
  }
  throw new PaymentReliabilityError(
    PAYMENT_RELIABILITY_ERROR.TRANSITION_CONFLICT,
    'Subscription kept changing while its plan was adopted',
  );
}

function applySourceToReduceSource(source: SubscriptionStateApplySource): 'webhook' | 'lookup' {
  return source === 'webhook' || source === 'reconcile_event' ? 'webhook' : 'lookup';
}

/**
 * Apply one status (with optional billing dates) to a subscription operation through the pure
 * reducer. `webhook`/`reconcile_event` follow the provider-state ordering by
 * `providerStateTimestamp`; `reconcile_provider`/`provider_mutation` are authoritative and leave the
 * watermark as it is. Provider ids are only filled in when the operation has none.
 */
export async function applySubscriptionTransition(
  store: OperationStore,
  input: ApplySubscriptionTransitionInput,
): Promise<PaymentOperation> {
  const source = applySourceToReduceSource(input.applySource ?? 'webhook');
  const operation = input.operation;
  const event: NormalizedSubscriptionEvent = {
    ...subscriptionEventFromProviderSnapshot(
      input.providerSubscriptionId ?? operation.providerSubscriptionId ?? '',
      {
        providerPlanId: input.providerPlanId ?? null,
        subscriptionStatus: input.subscriptionStatus,
        startTime: input.startTime ?? null,
        nextBillingTime: input.nextBillingTime ?? null,
      },
      { eventType: ENGINE_TRANSITION_EVENT_TYPE },
    ),
    stateAt: source === 'webhook' ? (input.providerStateTimestamp ?? null) : null,
  };
  const applied = await applySubscriptionEvents(store, {
    operation,
    steps: [{ event, options: { source } }],
    evidenceId: input.evidenceId ?? null,
    reason: input.reason,
    approvalUrl: input.approvalUrl,
    lifecycleReason: input.lifecycleReason,
  });
  return applied.operation;
}

export async function applyPlanTransition(
  store: OperationStore,
  input: ApplyPlanTransitionInput,
): Promise<PaymentOperation> {
  const { operation, planStatus } = input;
  if (operation.planStatus === planStatus) {
    return operation;
  }

  const nextExecution = resolveExecutionTransition(
    operation.status,
    planStatusToOperationStatus(planStatus),
  );

  return persistDomainAwareOperationUpdate(store, operation, {
    nextExecution,
    planStatus,
    providerReferenceId: input.providerReferenceId ?? operation.providerReferenceId,
    providerPlanId: input.providerPlanId ?? undefined,
    evidenceId: input.evidenceId ?? null,
    reason: input.reason,
  });
}

export async function applyPlanDomainUpdate(
  store: OperationStore,
  operation: PaymentOperation,
  input: {
    planStatus: PlanStatus;
    reason: string;
  },
): Promise<PaymentOperation> {
  if (operation.planStatus === input.planStatus) {
    return operation;
  }

  const nextExecution = resolveExecutionTransition(
    operation.status,
    planStatusToOperationStatus(input.planStatus),
  );

  return persistDomainAwareOperationUpdate(store, operation, {
    nextExecution,
    planStatus: input.planStatus,
    reason: input.reason,
  });
}

/**
 * @deprecated Lifecycle commands apply the provider's state with `applySubscriptionEvents` (the pure
 * reducer: plan check, never-move-back watermark, billing fields, hook effects). This writes the
 * status and watermark without those rules. Kept for existing callers; no engine caller left.
 */
export async function applySubscriptionDomainUpdate(
  store: OperationStore,
  operation: PaymentOperation,
  input: {
    subscriptionStatus: SubscriptionStatus;
    reason: string;
    lifecycleReason?: string | null;
    startTime?: string | null;
    nextBillingTime?: string | null;
    providerSubscriptionStateAt?: string | null;
  },
): Promise<PaymentOperation> {
  const current = operation.subscriptionStatus ?? 'approval_pending';
  const resolvedStatus = resolveSubscriptionStatusTransition(current, input.subscriptionStatus);

  const nextExecution = resolveExecutionTransition(
    operation.status,
    subscriptionStatusToOperationStatus(resolvedStatus),
  );

  return persistDomainAwareOperationUpdate(store, operation, {
    nextExecution,
    subscriptionStatus: resolvedStatus,
    lifecycleReason: input.lifecycleReason ?? undefined,
    startTime: input.startTime ?? undefined,
    nextBillingTime: input.nextBillingTime ?? undefined,
    ...(input.providerSubscriptionStateAt != null
      ? { providerStateWatermark: input.providerSubscriptionStateAt }
      : {}),
    reason: input.reason,
  });
}
