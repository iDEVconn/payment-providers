import {
  PAYMENT_RELIABILITY_ERROR,
  PAYMENT_TRANSITION_REJECTION_REASON,
  type CreatePaymentOperationInput,
  type PaymentEnvironment,
  type PaymentOperation,
  type PaymentOperationKind,
  type ProviderEvidenceRecord,
} from '../../contracts/index';
import type {
  CheckoutStore,
  MarketplaceStore,
  PayoutStore,
  SellerStore,
  SubscriptionStore,
} from '../../core/lib/persistence/payment-reliability-store';
import {
  CHECKOUT_STORE_METHODS,
  MARKETPLACE_STORE_METHODS,
  PAYOUT_STORE_METHODS,
  SELLER_STORE_METHODS,
} from '../../core/lib/persistence/store-capabilities';

/** The subset of an `expect` matcher the kit uses (vitest, jest and similar runners fit). */
export type ConformanceAssertion = {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
};

export type ConformanceExpect = (actual: unknown, message?: string) => ConformanceAssertion;

/** Optional capabilities the store under test implements, beyond `SubscriptionStore`. */
export type StoreConformanceCapabilities = {
  checkout?: boolean;
  payout?: boolean;
  seller?: boolean;
  marketplace?: boolean;
};

/** Default recovery lease used by the lease cases (1 s). */
export const DEFAULT_CONFORMANCE_LEASE_MS = 1_000;
/** Extra wait after the lease before the expiry case claims again. */
export const DEFAULT_CONFORMANCE_LEASE_MARGIN_MS = 500;

export type StoreConformanceOptions<TStore extends SubscriptionStore = SubscriptionStore> = {
  /**
   * Returns an EMPTY store for one test case (a fresh schema or truncated tables): the ordering and
   * listing cases read every row of the store. The concurrency cases (two claims, two transitions,
   * two inserts, two recovery workers) prove something only when the store runs each call on its
   * own connection and transaction: use a pool with at least two connections. `Promise.all` over a
   * single client serialises the calls, and the cases then pass without testing any locking.
   */
  createStore: () => TStore | Promise<TStore>;
  /** Called after each case with the store it used (close pools, drop schemas). */
  destroyStore?: (store: TStore) => void | Promise<void>;
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => Promise<void>) => void;
  expect: ConformanceExpect;
  capabilities?: StoreConformanceCapabilities;
  /**
   * Recovery lease the lease cases ask for. Default `DEFAULT_CONFORMANCE_LEASE_MS` (1 s). It must be
   * longer than one store round trip plus the skew between the database clock and the test clock:
   * a lease that expires before the next call arrives makes a correct store fail the
   * "not claimable by another" case.
   */
  leaseMs?: number;
  /**
   * How long the lease-expiry case waits before another worker claims the row. Default `leaseMs` +
   * `DEFAULT_CONFORMANCE_LEASE_MARGIN_MS`; must be longer than `leaseMs`. When only this option is
   * given, the lease is half of it.
   */
  leaseExpiryWaitMs?: number;
  /** Pause between inserts in the ordering cases so timestamps differ. Default 5 ms. */
  orderingGapMs?: number;
};

type CaseContext = {
  providerCode: string;
  accountRef: string;
  applicationRef: string;
  environment: PaymentEnvironment;
};

type Rejection = { code?: unknown; rejectionReason?: unknown };

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** An instant before every row a case inserts (a reached `nextAttemptAt` older than all of them). */
const PAST_ISO = '2000-01-01T00:00:00.000Z';

/** One hour after the test clock: far enough for any store clock skew. */
function futureIso(): string {
  return new Date(Date.now() + 3_600_000).toISOString();
}

function uniqueId(prefix: string): string {
  return `${prefix}-${globalThis.crypto.randomUUID()}`;
}

/** Resolves with the rejection (or `null` when the work succeeded). */
async function rejectionOf(work: () => Promise<unknown>): Promise<Rejection | null> {
  try {
    await work();
    return null;
  } catch (error) {
    return (error ?? {}) as Rejection;
  }
}

function missingMethods(store: object, methods: ReadonlyArray<string>): string[] {
  return methods.filter(
    (method) => typeof (store as Record<string, unknown>)[method] !== 'function',
  );
}

/**
 * Registers the store contract cases with the host's test runner. No dependency on a specific
 * runner: pass its `describe`, `it` and `expect`. Every case gets its own store from `createStore`.
 *
 * Covers: idempotency by fingerprint, optimistic `version` compare-and-set, the `prepared ->
 * submitted` claim and the create execution lease (one winner under concurrency, typed
 * `transitionKind`), transition + history atomicity, provider-id uniqueness per kind, patch
 * semantics (`undefined` keeps, `null` clears; also for `subscriptionStateJson`), evidence
 * uniqueness, recovery lease exclusivity and expiry, the retry backoff of the candidate lists
 * (`attempts`, `nextAttemptAt`, `retryStatus`, ORDER BY COALESCE(nextAttemptAt, created/received),
 * `includePendingVerification`, stale `submitted` creates), and the consumer-delivery fields.
 */
export function runStoreConformance<TStore extends SubscriptionStore>(
  options: StoreConformanceOptions<TStore>,
): void {
  const { describe, expect } = options;
  const capabilities = options.capabilities ?? {};
  const leaseMs =
    options.leaseMs ??
    (options.leaseExpiryWaitMs !== undefined
      ? Math.max(1, Math.floor(options.leaseExpiryWaitMs / 2))
      : DEFAULT_CONFORMANCE_LEASE_MS);
  const leaseExpiryWaitMs =
    options.leaseExpiryWaitMs ?? leaseMs + DEFAULT_CONFORMANCE_LEASE_MARGIN_MS;
  if (leaseExpiryWaitMs <= leaseMs) {
    throw new Error('runStoreConformance: leaseExpiryWaitMs must be longer than leaseMs');
  }
  const gapMs = options.orderingGapMs ?? 5;

  const it = (name: string, body: (store: TStore, ctx: CaseContext) => Promise<void>) => {
    options.it(name, async () => {
      const store = await options.createStore();
      const ctx: CaseContext = {
        providerCode: 'conformance',
        accountRef: uniqueId('acct'),
        applicationRef: 'conformance-app',
        environment: 'sandbox',
      };
      try {
        await body(store, ctx);
      } finally {
        await options.destroyStore?.(store);
      }
    });
  };

  const expectRejected = (
    rejection: Rejection | null,
    code: string,
    rejectionReason?: string,
  ): void => {
    expect(rejection?.code ?? 'no error thrown', `error code`).toBe(code);
    if (rejectionReason !== undefined) {
      expect(rejection?.rejectionReason, 'rejectionReason').toBe(rejectionReason);
    }
  };

  const createOperation = (
    store: SubscriptionStore,
    ctx: CaseContext,
    over: Partial<CreatePaymentOperationInput> & {
      kind?: PaymentOperationKind;
    } = {},
  ): Promise<PaymentOperation> =>
    store.createOperation({
      ...ctx,
      idempotencyKey: uniqueId('idem'),
      idempotencyScope: `${ctx.applicationRef}:${ctx.accountRef}:${over.kind ?? 'subscription'}`,
      commandFingerprint: 'fp-1',
      kind: 'subscription',
      ...over,
    });

  const claim = (store: SubscriptionStore, operation: PaymentOperation) =>
    store.claimOperationForExecution({
      operationId: operation.operationId,
      expectedVersion: operation.version,
    });

  const toUnknown = async (store: SubscriptionStore, operation: PaymentOperation) => {
    const claimed = await claim(store, operation);
    return store.transitionOperation({
      operationId: claimed.operationId,
      expectedVersion: claimed.version,
      nextStatus: 'unknown',
      executionOwnerToken: null,
      executionLeaseExpiresAt: null,
      reason: 'conformance: provider outcome unknown',
    });
  };

  const insertEvidence = (
    store: SubscriptionStore,
    ctx: CaseContext,
    providerEventId = uniqueId('evt'),
  ): Promise<ProviderEvidenceRecord> =>
    store.insertEvidence({
      ...ctx,
      evidenceKind: 'webhook',
      providerEventId,
      rawPayload: `{"id":"${providerEventId}"}`,
      payloadSha256: 'sha-conformance',
      eventType: 'BILLING.SUBSCRIPTION.ACTIVATED',
      resourceId: 'I-CONFORMANCE',
    });

  const insertEvidenceIn = async (
    store: SubscriptionStore,
    ctx: CaseContext,
    state: Partial<
      Pick<
        ProviderEvidenceRecord,
        'verificationStatus' | 'processingStatus' | 'consumerDeliveryStatus'
      >
    >,
  ): Promise<ProviderEvidenceRecord> => {
    const row = await insertEvidence(store, ctx);
    if (Object.keys(state).length === 0) {
      return row;
    }
    return store.updateEvidence({ evidenceId: row.evidenceId, ...state });
  };

  describe('payment store conformance', () => {
    describe('idempotency', () => {
      it('createOperation inserts prepared at version 1 and replays the same key and fingerprint', async (store, ctx) => {
        const first = await createOperation(store, ctx, {
          idempotencyKey: 'idem-replay',
        });
        expect(first.status).toBe('prepared');
        expect(first.version).toBe(1);
        const replay = await createOperation(store, ctx, {
          idempotencyKey: 'idem-replay',
        });
        expect(replay.operationId).toBe(first.operationId);
        const found = await store.findOperationByIdempotency(first.idempotencyScope, 'idem-replay');
        expect(found?.operationId).toBe(first.operationId);
      });

      it('a different command fingerprint for the same key throws IDEMPOTENCY_CONFLICT', async (store, ctx) => {
        await createOperation(store, ctx, { idempotencyKey: 'idem-fp' });
        const rejection = await rejectionOf(() =>
          createOperation(store, ctx, {
            idempotencyKey: 'idem-fp',
            commandFingerprint: 'fp-2',
          }),
        );
        expectRejected(rejection, PAYMENT_RELIABILITY_ERROR.IDEMPOTENCY_CONFLICT);
      });

      it('concurrent creates with one key return a single operation', async (store, ctx) => {
        const results = await Promise.all(
          Array.from({ length: 5 }, () =>
            createOperation(store, ctx, { idempotencyKey: 'idem-race' }),
          ),
        );
        expect(new Set(results.map((row) => row.operationId)).size).toBe(1);
      });
    });

    describe('optimistic version', () => {
      it('updateOperation is a compare-and-set on version and changes nothing on a conflict', async (store, ctx) => {
        const created = await createOperation(store, ctx);
        const updated = await store.updateOperation({
          operationId: created.operationId,
          expectedVersion: created.version,
          lifecycleReason: 'first',
        });
        expect(updated.version).toBe(created.version + 1);
        const rejection = await rejectionOf(() =>
          store.updateOperation({
            operationId: created.operationId,
            expectedVersion: created.version,
            lifecycleReason: 'stale writer',
          }),
        );
        expectRejected(rejection, PAYMENT_RELIABILITY_ERROR.TRANSITION_CONFLICT);
        const after = await store.findOperationById(created.operationId);
        expect(after?.version).toBe(updated.version);
        expect(after?.lifecycleReason).toBe('first');
      });

      it('transitionOperation with a stale version throws TRANSITION_CONFLICT', async (store, ctx) => {
        const created = await createOperation(store, ctx);
        const claimed = await claim(store, created);
        const rejection = await rejectionOf(() =>
          store.transitionOperation({
            operationId: claimed.operationId,
            expectedVersion: created.version,
            nextStatus: 'unknown',
            reason: 'stale',
          }),
        );
        expectRejected(rejection, PAYMENT_RELIABILITY_ERROR.TRANSITION_CONFLICT);
      });
    });

    describe('claim prepared -> submitted', () => {
      it('claimOperationForExecution moves prepared to submitted and records transitionKind claim_execution', async (store, ctx) => {
        const created = await createOperation(store, ctx);
        const claimed = await claim(store, created);
        expect(claimed.status).toBe('submitted');
        expect(claimed.version).toBe(created.version + 1);
        const history = await store.listOperationTransitions(created.operationId);
        expect(history.length).toBe(1);
        expect(history[0]?.fromStatus).toBe('prepared');
        expect(history[0]?.toStatus).toBe('submitted');
        expect(history[0]?.transitionKind).toBe('claim_execution');
      });

      it('of two concurrent claims exactly one wins; the other throws OPERATION_CONFLICT', async (store, ctx) => {
        const created = await createOperation(store, ctx);
        const results = await Promise.allSettled([claim(store, created), claim(store, created)]);
        expect(results.filter((result) => result.status === 'fulfilled').length).toBe(1);
        const loser = results.find((result) => result.status === 'rejected');
        expectRejected(
          (loser as PromiseRejectedResult | undefined)?.reason ?? null,
          PAYMENT_RELIABILITY_ERROR.OPERATION_CONFLICT,
        );
        expect((await store.listOperationTransitions(created.operationId)).length).toBe(1);
      });

      it('a claim of an operation that is not prepared throws OPERATION_CONFLICT', async (store, ctx) => {
        const claimed = await claim(store, await createOperation(store, ctx));
        expectRejected(
          await rejectionOf(() => claim(store, claimed)),
          PAYMENT_RELIABILITY_ERROR.OPERATION_CONFLICT,
        );
      });

      it('create execution lease: one acquired of two concurrent calls, claim_execution from prepared', async (store, ctx) => {
        const created = await createOperation(store, ctx);
        const input = {
          operationId: created.operationId,
          expectedVersion: created.version,
        };
        const results = await Promise.allSettled([
          store.acquireCheckoutCreateExecutionLease(input),
          store.acquireCheckoutCreateExecutionLease(input),
        ]);
        const kinds = results
          .map((result) => (result.status === 'fulfilled' ? result.value.kind : 'rejected'))
          .sort();
        expect(kinds.filter((kind) => kind === 'acquired').length).toBe(1);
        const acquired = results.find(
          (result) => result.status === 'fulfilled' && result.value.kind === 'acquired',
        ) as PromiseFulfilledResult<{
          kind: 'acquired';
          operation: PaymentOperation;
          executionOwnerToken: string;
        }>;
        expect(acquired.value.operation.status).toBe('submitted');
        expect(acquired.value.operation.executionOwnerToken).toBe(
          acquired.value.executionOwnerToken,
        );
        const history = await store.listOperationTransitions(created.operationId);
        expect(history.map((row) => row.transitionKind ?? null)).toEqual(['claim_execution']);
      });

      it('create execution lease from unknown records claim_retry; a provider reference is not_eligible', async (store, ctx) => {
        const unknown = await toUnknown(store, await createOperation(store, ctx));
        const retry = await store.acquireCheckoutCreateExecutionLease({
          operationId: unknown.operationId,
          expectedVersion: unknown.version,
        });
        expect(retry.kind).toBe('acquired');
        const history = await store.listOperationTransitions(unknown.operationId);
        expect(history[history.length - 1]?.transitionKind).toBe('claim_retry');

        const bound = await createOperation(store, ctx, {
          providerSubscriptionId: uniqueId('I'),
        });
        const notEligible = await store.acquireCheckoutCreateExecutionLease({
          operationId: bound.operationId,
          expectedVersion: bound.version,
        });
        expect(notEligible.kind).toBe('not_eligible');
      });
    });

    describe('transition and history atomicity', () => {
      it('a transition writes exactly one history row with reason, evidence id and transitionKind', async (store, ctx) => {
        const created = await createOperation(store, ctx);
        const evidence = await insertEvidence(store, ctx);
        const claimed = await claim(store, created);
        await store.transitionOperation({
          operationId: claimed.operationId,
          expectedVersion: claimed.version,
          nextStatus: 'unknown',
          evidenceId: evidence.evidenceId,
          reason: 'free text that services never read',
          transitionKind: 'claim_retry',
        });
        const history = await store.listOperationTransitions(created.operationId);
        expect(history.map((row) => `${row.fromStatus}->${row.toStatus}`)).toEqual([
          'prepared->submitted',
          'submitted->unknown',
        ]);
        expect(history[1]?.evidenceId).toBe(evidence.evidenceId);
        expect(history[1]?.reason).toBe('free text that services never read');
        expect(history[1]?.transitionKind).toBe('claim_retry');
      });

      it('a transition without transitionKind stores null', async (store, ctx) => {
        const claimed = await claim(store, await createOperation(store, ctx));
        await store.transitionOperation({
          operationId: claimed.operationId,
          expectedVersion: claimed.version,
          nextStatus: 'unknown',
          reason: 'plain',
        });
        const history = await store.listOperationTransitions(claimed.operationId);
        expect(history[1]?.transitionKind ?? null).toBe(null);
      });

      it('a rejected transition writes no history row and leaves the operation unchanged', async (store, ctx) => {
        const claimed = await claim(store, await createOperation(store, ctx));
        const done = await store.transitionOperation({
          operationId: claimed.operationId,
          expectedVersion: claimed.version,
          nextStatus: 'succeeded',
          reason: 'done',
        });
        expectRejected(
          await rejectionOf(() =>
            store.transitionOperation({
              operationId: done.operationId,
              expectedVersion: done.version,
              nextStatus: 'submitted',
              lifecycleReason: 'must not be written',
              reason: 'regress',
            }),
          ),
          PAYMENT_RELIABILITY_ERROR.TRANSITION_REJECTED,
          PAYMENT_TRANSITION_REJECTION_REASON.INVALID_TRANSITION,
        );
        const after = await store.findOperationById(done.operationId);
        expect(after?.version).toBe(done.version);
        expect(after?.lifecycleReason ?? null).toBe(null);
        expect((await store.listOperationTransitions(done.operationId)).length).toBe(2);
      });

      it('an execution owner mismatch is rejected and writes nothing', async (store, ctx) => {
        const created = await createOperation(store, ctx);
        const lease = await store.acquireCheckoutCreateExecutionLease({
          operationId: created.operationId,
          expectedVersion: created.version,
        });
        expectRejected(
          await rejectionOf(() =>
            store.transitionOperation({
              operationId: lease.operation.operationId,
              expectedVersion: lease.operation.version,
              nextStatus: 'unknown',
              expectedExecutionOwnerToken: 'someone-else',
              reason: 'not mine',
            }),
          ),
          PAYMENT_RELIABILITY_ERROR.TRANSITION_REJECTED,
          PAYMENT_TRANSITION_REJECTION_REASON.EXECUTION_OWNER_MISMATCH,
        );
        expect((await store.listOperationTransitions(created.operationId)).length).toBe(1);
      });

      it('of two concurrent transitions at one version exactly one is applied and recorded', async (store, ctx) => {
        const claimed = await claim(store, await createOperation(store, ctx));
        const results = await Promise.allSettled(
          (['unknown', 'failed'] as const).map((nextStatus) =>
            store.transitionOperation({
              operationId: claimed.operationId,
              expectedVersion: claimed.version,
              nextStatus,
              reason: `race to ${nextStatus}`,
            }),
          ),
        );
        expect(results.filter((result) => result.status === 'fulfilled').length).toBe(1);
        expect((await store.listOperationTransitions(claimed.operationId)).length).toBe(2);
        const after = await store.findOperationById(claimed.operationId);
        expect(after?.version).toBe(claimed.version + 1);
      });
    });

    describe('provider-id uniqueness per kind', () => {
      it('a provider id bound to another operation of the same kind is rejected (transition, update, create)', async (store, ctx) => {
        const subscriptionId = uniqueId('I');
        const owner = await claim(store, await createOperation(store, ctx));
        await store.transitionOperation({
          operationId: owner.operationId,
          expectedVersion: owner.version,
          nextStatus: 'submitted',
          providerSubscriptionId: subscriptionId,
          reason: 'bind',
        });
        const other = await claim(store, await createOperation(store, ctx));
        expectRejected(
          await rejectionOf(() =>
            store.transitionOperation({
              operationId: other.operationId,
              expectedVersion: other.version,
              nextStatus: 'submitted',
              providerSubscriptionId: subscriptionId,
              reason: 'steal',
            }),
          ),
          PAYMENT_RELIABILITY_ERROR.TRANSITION_REJECTED,
          PAYMENT_TRANSITION_REJECTION_REASON.PROVIDER_REFERENCE_BOUND,
        );
        expectRejected(
          await rejectionOf(() =>
            store.updateOperation({
              operationId: other.operationId,
              expectedVersion: other.version,
              providerSubscriptionId: subscriptionId,
            }),
          ),
          PAYMENT_RELIABILITY_ERROR.TRANSITION_REJECTED,
          PAYMENT_TRANSITION_REJECTION_REASON.PROVIDER_REFERENCE_BOUND,
        );
        expectRejected(
          await rejectionOf(() =>
            createOperation(store, ctx, {
              providerSubscriptionId: subscriptionId,
            }),
          ),
          PAYMENT_RELIABILITY_ERROR.TRANSITION_REJECTED,
          PAYMENT_TRANSITION_REJECTION_REASON.PROVIDER_REFERENCE_BOUND,
        );
        const found = await store.findOperationByProviderSubscriptionId(
          ctx.providerCode,
          ctx.accountRef,
          ctx.environment,
          subscriptionId,
        );
        expect(found?.operationId).toBe(owner.operationId);
        expect((await store.findOperationById(other.operationId))?.version).toBe(other.version);
      });

      it('a provider reference id is unique across kinds', async (store, ctx) => {
        const reference = uniqueId('REF');
        const owner = await claim(store, await createOperation(store, ctx));
        await store.transitionOperation({
          operationId: owner.operationId,
          expectedVersion: owner.version,
          nextStatus: 'submitted',
          providerReferenceId: reference,
          reason: 'bind',
        });
        const plan = await claim(
          store,
          await createOperation(store, ctx, { kind: 'billing_plan' }),
        );
        expectRejected(
          await rejectionOf(() =>
            store.transitionOperation({
              operationId: plan.operationId,
              expectedVersion: plan.version,
              nextStatus: 'submitted',
              providerReferenceId: reference,
              reason: 'steal',
            }),
          ),
          PAYMENT_RELIABILITY_ERROR.TRANSITION_REJECTED,
          PAYMENT_TRANSITION_REJECTION_REASON.PROVIDER_REFERENCE_BOUND,
        );
        const found = await store.findOperationByProviderReference(
          ctx.providerCode,
          ctx.accountRef,
          ctx.environment,
          reference,
        );
        expect(found?.operationId).toBe(owner.operationId);
      });

      it('product, plan and subscription lookups are scoped to their kind and environment', async (store, ctx) => {
        const productId = uniqueId('PROD');
        const planId = uniqueId('P');
        const subscriptionId = uniqueId('I');
        const product = await createOperation(store, ctx, {
          kind: 'catalog_product',
          providerProductId: productId,
        });
        const plan = await createOperation(store, ctx, {
          kind: 'billing_plan',
          providerPlanId: planId,
          providerProductId: productId,
        });
        const subscription = await createOperation(store, ctx, {
          providerPlanId: planId,
          providerSubscriptionId: subscriptionId,
        });
        // Lifecycle command operations carry the ids without competing for them.
        await createOperation(store, ctx, {
          kind: 'subscription_cancel',
          providerPlanId: planId,
          providerSubscriptionId: subscriptionId,
        });
        const { providerCode, accountRef, environment } = ctx;
        expect(
          (
            await store.findOperationByProviderProductId(
              providerCode,
              accountRef,
              environment,
              productId,
            )
          )?.operationId,
        ).toBe(product.operationId);
        expect(
          (await store.findOperationByProviderPlanId(providerCode, accountRef, environment, planId))
            ?.operationId,
        ).toBe(plan.operationId);
        expect(
          (
            await store.findOperationByProviderSubscriptionId(
              providerCode,
              accountRef,
              environment,
              subscriptionId,
            )
          )?.operationId,
        ).toBe(subscription.operationId);
        expect(
          await store.findOperationByProviderSubscriptionId(
            providerCode,
            accountRef,
            'live',
            subscriptionId,
          ),
        ).toBe(null);
      });

      it('clearing a provider id with null frees it', async (store, ctx) => {
        const subscriptionId = uniqueId('I');
        const owner = await createOperation(store, ctx, {
          providerSubscriptionId: subscriptionId,
        });
        await store.updateOperation({
          operationId: owner.operationId,
          expectedVersion: owner.version,
          providerSubscriptionId: null,
        });
        const { providerCode, accountRef, environment } = ctx;
        expect(
          await store.findOperationByProviderSubscriptionId(
            providerCode,
            accountRef,
            environment,
            subscriptionId,
          ),
        ).toBe(null);
        const next = await createOperation(store, ctx, {
          providerSubscriptionId: subscriptionId,
        });
        expect(
          (
            await store.findOperationByProviderSubscriptionId(
              providerCode,
              accountRef,
              environment,
              subscriptionId,
            )
          )?.operationId,
        ).toBe(next.operationId);
      });
    });

    describe('patch semantics', () => {
      it('updateOperation: undefined keeps and null clears', async (store, ctx) => {
        const created = await createOperation(store, ctx);
        const set = await store.updateOperation({
          operationId: created.operationId,
          expectedVersion: created.version,
          nextBillingTime: '2026-02-01T00:00:00.000Z',
          approvalUrl: 'https://example.test/approve',
          lifecycleReason: 'kept',
        });
        const kept = await store.updateOperation({
          operationId: set.operationId,
          expectedVersion: set.version,
          approvalUrl: null,
        });
        expect(kept.nextBillingTime).toBe('2026-02-01T00:00:00.000Z');
        expect(kept.lifecycleReason).toBe('kept');
        expect(kept.approvalUrl).toBe(null);
        expect((await store.findOperationById(created.operationId))?.approvalUrl).toBe(null);
      });

      it('subscriptionStateJson is stored by create, update and transition (undefined keeps, null clears)', async (store, ctx) => {
        const state = (failedPaymentsCount: number) => ({
          version: 1,
          failedPaymentsCount,
          recentEventIds: ['WH-1'],
        });
        // A text column returns the JSON as written, a jsonb column may reformat it or return the
        // parsed object: the kit compares the parsed content.
        const parsed = (value: unknown): unknown =>
          typeof value === 'string' ? (JSON.parse(value) as unknown) : (value ?? null);
        const created = await createOperation(store, ctx, {
          subscriptionStateJson: JSON.stringify(state(1)),
        });
        expect(parsed(created.subscriptionStateJson), 'subscriptionStateJson after create').toEqual(
          state(1),
        );
        const updated = await store.updateOperation({
          operationId: created.operationId,
          expectedVersion: created.version,
          subscriptionStateJson: JSON.stringify(state(2)),
        });
        const kept = await store.updateOperation({
          operationId: updated.operationId,
          expectedVersion: updated.version,
          lifecycleReason: 'other field',
        });
        expect(parsed(kept.subscriptionStateJson), 'subscriptionStateJson kept').toEqual(state(2));
        const claimed = await claim(store, kept);
        const transitioned = await store.transitionOperation({
          operationId: claimed.operationId,
          expectedVersion: claimed.version,
          nextStatus: 'succeeded',
          subscriptionStateJson: JSON.stringify(state(3)),
          reason: 'conformance: state from the reducer',
        });
        expect(
          parsed((await store.findOperationById(created.operationId))?.subscriptionStateJson),
          'subscriptionStateJson after transition',
        ).toEqual(state(3));
        const cleared = await store.updateOperation({
          operationId: transitioned.operationId,
          expectedVersion: transitioned.version,
          subscriptionStateJson: null,
        });
        expect(parsed(cleared.subscriptionStateJson), 'subscriptionStateJson cleared').toBe(null);
      });

      it('transitionOperation: failureCode and failureMessage, undefined keeps and null clears', async (store, ctx) => {
        const claimed = await claim(store, await createOperation(store, ctx));
        const failed = await store.transitionOperation({
          operationId: claimed.operationId,
          expectedVersion: claimed.version,
          nextStatus: 'unknown',
          failureCode: 'PROVIDER_UNCERTAIN',
          failureMessage: 'timed out',
          reason: 'timeout',
        });
        const kept = await store.transitionOperation({
          operationId: failed.operationId,
          expectedVersion: failed.version,
          nextStatus: 'unknown',
          reason: 'still unknown',
        });
        expect(kept.failureCode).toBe('PROVIDER_UNCERTAIN');
        expect(kept.failureMessage).toBe('timed out');
        const cleared = await store.transitionOperation({
          operationId: kept.operationId,
          expectedVersion: kept.version,
          nextStatus: 'submitted',
          failureCode: null,
          failureMessage: null,
          reason: 'resolved',
        });
        expect(cleared.failureCode).toBe(null);
        expect(cleared.failureMessage).toBe(null);
      });

      it('transitionOperation: providerReferenceId null keeps the bound reference', async (store, ctx) => {
        const reference = uniqueId('REF');
        const claimed = await claim(store, await createOperation(store, ctx));
        const bound = await store.transitionOperation({
          operationId: claimed.operationId,
          expectedVersion: claimed.version,
          nextStatus: 'unknown',
          providerReferenceId: reference,
          reason: 'bind',
        });
        const after = await store.transitionOperation({
          operationId: bound.operationId,
          expectedVersion: bound.version,
          nextStatus: 'submitted',
          providerReferenceId: null,
          reason: 'webhook without resource id',
        });
        expect(after.providerReferenceId).toBe(reference);
      });

      it('updateEvidence: undefined keeps and null clears', async (store, ctx) => {
        const operation = await createOperation(store, ctx);
        const row = await insertEvidence(store, ctx);
        const set = await store.updateEvidence({
          evidenceId: row.evidenceId,
          errorCode: 'VERIFICATION_UNAVAILABLE',
          errorMessage: 'down',
          processedAt: '2026-01-01T00:00:00.000Z',
          relatedOperationId: operation.operationId,
        });
        expect(set.errorCode).toBe('VERIFICATION_UNAVAILABLE');
        const kept = await store.updateEvidence({
          evidenceId: row.evidenceId,
          verificationStatus: 'verified',
        });
        expect(kept.errorMessage).toBe('down');
        expect(kept.processedAt).toBe('2026-01-01T00:00:00.000Z');
        expect(kept.relatedOperationId).toBe(operation.operationId);
        const cleared = await store.updateEvidence({
          evidenceId: row.evidenceId,
          errorCode: null,
          errorMessage: null,
          processedAt: null,
          relatedOperationId: null,
        });
        expect([
          cleared.errorCode,
          cleared.errorMessage,
          cleared.processedAt,
          cleared.relatedOperationId,
        ]).toEqual([null, null, null, null]);
        expect((await store.findEvidenceById(row.evidenceId))?.processedAt).toBe(null);
      });
    });

    describe('evidence uniqueness', () => {
      it('inserts pending evidence and finds it by id and by provider event', async (store, ctx) => {
        const row = await insertEvidence(store, ctx, 'WH-FIND');
        expect(row.verificationStatus).toBe('pending');
        expect(row.processingStatus).toBe('pending');
        expect(row.rawPayload).toBe('{"id":"WH-FIND"}');
        expect((await store.findEvidenceById(row.evidenceId))?.providerEventId).toBe('WH-FIND');
        const byEvent = await store.findEvidenceByProviderEvent(
          ctx.providerCode,
          ctx.accountRef,
          ctx.environment,
          'WH-FIND',
        );
        expect(byEvent?.evidenceId).toBe(row.evidenceId);
      });

      it('a duplicate provider event id in the same scope throws EVIDENCE_DUPLICATE, also concurrently', async (store, ctx) => {
        await insertEvidence(store, ctx, 'WH-DUP');
        expectRejected(
          await rejectionOf(() => insertEvidence(store, ctx, 'WH-DUP')),
          PAYMENT_RELIABILITY_ERROR.EVIDENCE_DUPLICATE,
        );
        const otherAccount = await insertEvidence(
          store,
          { ...ctx, accountRef: uniqueId('acct') },
          'WH-DUP',
        );
        expect(otherAccount.providerEventId).toBe('WH-DUP');
        const race = await Promise.allSettled([
          insertEvidence(store, ctx, 'WH-RACE'),
          insertEvidence(store, ctx, 'WH-RACE'),
        ]);
        expect(race.filter((result) => result.status === 'fulfilled').length).toBe(1);
        const loser = race.find((result) => result.status === 'rejected') as
          | PromiseRejectedResult
          | undefined;
        expectRejected(loser?.reason ?? null, PAYMENT_RELIABILITY_ERROR.EVIDENCE_DUPLICATE);
      });
    });

    describe('recovery lease', () => {
      it('claimPendingEvidence requires a workerId', async (store) => {
        expectRejected(
          await rejectionOf(() =>
            store.claimPendingEvidence({
              limit: 1,
              leaseMs: leaseMs,
              workerId: '  ',
            }),
          ),
          PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        );
      });

      it('claims only recoverable rows, oldest first, and honours includeConsumerDelivery', async (store, ctx) => {
        const pending = await insertEvidenceIn(store, ctx, {});
        await pause(gapMs);
        const toProcess = await insertEvidenceIn(store, ctx, {
          verificationStatus: 'verified',
        });
        await pause(gapMs);
        await insertEvidenceIn(store, ctx, {
          verificationStatus: 'verified',
          processingStatus: 'processed',
          consumerDeliveryStatus: 'confirmed',
        });
        await insertEvidenceIn(store, ctx, {
          verificationStatus: 'rejected',
          processingStatus: 'failed',
        });
        await pause(gapMs);
        const unmatched = await insertEvidenceIn(store, ctx, {
          verificationStatus: 'verified',
          processingStatus: 'unmatched',
        });
        await pause(gapMs);
        const awaitingDelivery = await insertEvidenceIn(store, ctx, {
          verificationStatus: 'verified',
          processingStatus: 'processed',
          consumerDeliveryStatus: 'failed',
        });
        await insertEvidenceIn(store, ctx, {
          verificationStatus: 'verified',
          processingStatus: 'processed',
          consumerDeliveryStatus: 'failed_terminal',
        });

        const withoutDelivery = await store.claimPendingEvidence({
          limit: 10,
          leaseMs,
          workerId: 'w1',
          includeConsumerDelivery: false,
        });
        expect(withoutDelivery.map((row) => row.evidenceId)).toEqual([
          pending.evidenceId,
          toProcess.evidenceId,
          unmatched.evidenceId,
        ]);
        const all = await store.claimPendingEvidence({
          limit: 10,
          leaseMs,
          workerId: 'w1',
        });
        expect(all.map((row) => row.evidenceId)).toEqual([
          pending.evidenceId,
          toProcess.evidenceId,
          unmatched.evidenceId,
          awaitingDelivery.evidenceId,
        ]);
        expect(
          all.every((row) => row.claimWorkerId === 'w1' && row.claimLeaseExpiresAt !== null),
        ).toBe(true);
        const limited = await store.claimPendingEvidence({
          limit: 2,
          leaseMs,
          workerId: 'w1',
        });
        expect(limited.map((row) => row.evidenceId)).toEqual([
          pending.evidenceId,
          toProcess.evidenceId,
        ]);
      });

      // Exclusivity only: a store without SKIP LOCKED may return fewer rows than `limit` under
      // contention, but never a row another worker holds; a later claim picks up the rest.
      it('two concurrent workers get disjoint rows and a later claim gets the rest', async (store, ctx) => {
        const inserted: string[] = [];
        for (let index = 0; index < 4; index += 1) {
          inserted.push((await insertEvidenceIn(store, ctx, {})).evidenceId);
        }
        const [first, second] = await Promise.all([
          store.claimPendingEvidence({
            limit: 2,
            leaseMs: 60_000,
            workerId: 'w1',
          }),
          store.claimPendingEvidence({
            limit: 2,
            leaseMs: 60_000,
            workerId: 'w2',
          }),
        ]);
        const ids = [...(first ?? []), ...(second ?? [])].map((row) => row.evidenceId);
        expect(new Set(ids).size, 'a row was claimed by both workers').toBe(ids.length);
        expect(ids.every((id) => inserted.includes(id))).toBe(true);
        const rest = await store.claimPendingEvidence({
          limit: 10,
          leaseMs: 60_000,
          workerId: 'w3',
        });
        const all = [...ids, ...rest.map((row) => row.evidenceId)];
        expect(new Set(all).size, 'a row was claimed twice').toBe(all.length);
        expect([...all].sort()).toEqual([...inserted].sort());
      });

      it('a lease held by one worker is not claimable by another until it expires', async (store, ctx) => {
        const row = await insertEvidenceIn(store, ctx, {});
        expect(
          (
            await store.claimPendingEvidence({
              limit: 5,
              leaseMs,
              workerId: 'w1',
            })
          ).length,
        ).toBe(1);
        expect(
          (
            await store.claimPendingEvidence({
              limit: 5,
              leaseMs,
              workerId: 'w2',
            })
          ).length,
        ).toBe(0);
        expect(
          (
            await store.claimPendingEvidence({
              limit: 5,
              leaseMs,
              workerId: 'w1',
            })
          ).length,
        ).toBe(1);
        await pause(leaseExpiryWaitMs);
        const taken = await store.claimPendingEvidence({
          limit: 5,
          leaseMs,
          workerId: 'w2',
        });
        expect(taken.map((claimed) => claimed.evidenceId)).toEqual([row.evidenceId]);
        expect(taken[0]?.claimWorkerId).toBe('w2');
      });
    });

    // Order: due rows only (`retryStatus` null, `nextAttemptAt` null or reached), by
    // COALESCE(nextAttemptAt, receivedAt/createdAt), then id. Each list is checked with a row
    // deferred into the future (excluded), one that gave up (excluded) and one whose past
    // `nextAttemptAt` is older than every insert time (first).
    describe('candidate ordering and retry backoff', () => {
      it('listReconciliationCandidates: due verified unmatched webhook evidence, oldest first by nextAttemptAt/receivedAt', async (store, ctx) => {
        const unmatched = () =>
          insertEvidenceIn(store, ctx, {
            verificationStatus: 'verified',
            processingStatus: 'unmatched',
          });
        const deferred = await unmatched();
        await pause(gapMs);
        const first = await unmatched();
        await pause(gapMs);
        const dueEarlier = await unmatched();
        await pause(gapMs);
        const gaveUp = await unmatched();
        await pause(gapMs);
        const last = await unmatched();
        await insertEvidenceIn(store, ctx, { processingStatus: 'unmatched' });
        await store.updateEvidence({
          evidenceId: deferred.evidenceId,
          attempts: 1,
          nextAttemptAt: futureIso(),
        });
        await store.updateEvidence({
          evidenceId: dueEarlier.evidenceId,
          attempts: 2,
          nextAttemptAt: PAST_ISO,
        });
        await store.updateEvidence({
          evidenceId: gaveUp.evidenceId,
          attempts: 20,
          retryStatus: 'gave_up',
        });
        const ids = [dueEarlier, first, last].map((row) => row.evidenceId);
        expect(
          (await store.listReconciliationCandidates(10)).map((row) => row.evidenceId),
          'due rows, oldest first by nextAttemptAt/receivedAt',
        ).toEqual(ids);
        expect((await store.listReconciliationCandidates(2)).map((row) => row.evidenceId)).toEqual(
          ids.slice(0, 2),
        );
      });

      it('listUncertainOperations: due unknown operations, oldest first by nextAttemptAt/createdAt', async (store, ctx) => {
        const created: PaymentOperation[] = [];
        for (let index = 0; index < 5; index += 1) {
          created.push(await createOperation(store, ctx));
          await pause(gapMs);
        }
        await createOperation(store, ctx);
        const unknown: PaymentOperation[] = [];
        for (const operation of [...created].reverse()) {
          unknown.unshift(await toUnknown(store, operation));
          await pause(gapMs);
        }
        const [deferred, first, dueEarlier, gaveUp, last] = unknown as [
          PaymentOperation,
          PaymentOperation,
          PaymentOperation,
          PaymentOperation,
          PaymentOperation,
        ];
        await store.updateOperation({
          operationId: deferred.operationId,
          expectedVersion: deferred.version,
          attempts: 1,
          nextAttemptAt: futureIso(),
        });
        await store.updateOperation({
          operationId: dueEarlier.operationId,
          expectedVersion: dueEarlier.version,
          attempts: 2,
          nextAttemptAt: PAST_ISO,
        });
        await store.updateOperation({
          operationId: gaveUp.operationId,
          expectedVersion: gaveUp.version,
          attempts: 20,
          retryStatus: 'gave_up',
        });
        const ids = [dueEarlier, first, last].map((operation) => operation.operationId);
        expect(
          (await store.listUncertainOperations(10)).map((row) => row.operationId),
          'due rows, oldest first by nextAttemptAt/createdAt',
        ).toEqual(ids);
        expect((await store.listUncertainOperations(2)).map((row) => row.operationId)).toEqual(
          ids.slice(0, 2),
        );
      });

      it('claimPendingEvidence: due rows only, oldest first by nextAttemptAt/receivedAt; evidenceIds ignore nextAttemptAt', async (store, ctx) => {
        const deferred = await insertEvidenceIn(store, ctx, { verificationStatus: 'verified' });
        await pause(gapMs);
        const first = await insertEvidenceIn(store, ctx, { verificationStatus: 'verified' });
        await pause(gapMs);
        const dueEarlier = await insertEvidenceIn(store, ctx, { verificationStatus: 'verified' });
        await pause(gapMs);
        const gaveUp = await insertEvidenceIn(store, ctx, {
          verificationStatus: 'verified',
          processingStatus: 'unmatched',
        });
        const gaveUpAwaitingDelivery = await insertEvidenceIn(store, ctx, {
          verificationStatus: 'verified',
          processingStatus: 'processed',
          consumerDeliveryStatus: 'pending',
        });
        await store.updateEvidence({
          evidenceId: deferred.evidenceId,
          attempts: 1,
          nextAttemptAt: futureIso(),
        });
        await store.updateEvidence({
          evidenceId: dueEarlier.evidenceId,
          attempts: 3,
          nextAttemptAt: PAST_ISO,
        });
        for (const row of [gaveUp, gaveUpAwaitingDelivery]) {
          await store.updateEvidence({
            evidenceId: row.evidenceId,
            attempts: 20,
            retryStatus: 'gave_up',
          });
        }
        const claimed = await store.claimPendingEvidence({
          limit: 10,
          leaseMs: 60_000,
          workerId: 'w1',
        });
        expect(
          claimed.map((row) => row.evidenceId),
          'due rows, oldest first by nextAttemptAt/receivedAt; gave_up only for delivery',
        ).toEqual([dueEarlier, first, gaveUpAwaitingDelivery].map((row) => row.evidenceId));
        const named = await store.claimPendingEvidence({
          limit: 10,
          leaseMs: 60_000,
          workerId: 'w2',
          evidenceIds: [deferred.evidenceId, gaveUp.evidenceId],
        });
        expect(
          named.map((row) => row.evidenceId),
          'evidenceIds ignore nextAttemptAt, never gave_up',
        ).toEqual([deferred.evidenceId]);
      });

      it('listReconciliationCandidates lists only webhook evidence, never reconciliation-kind rows', async (store, ctx) => {
        const webhook = await insertEvidenceIn(store, ctx, {
          verificationStatus: 'verified',
          processingStatus: 'unmatched',
        });
        const own = await store.insertEvidence({
          ...ctx,
          evidenceKind: 'reconciliation',
          providerEventId: uniqueId('reconcile'),
          rawPayload: '{}',
          payloadSha256: 'sha-conformance',
          eventType: 'RECONCILIATION.PROVIDER_LOOKUP',
          resourceId: 'I-CONFORMANCE',
        });
        await store.updateEvidence({
          evidenceId: own.evidenceId,
          verificationStatus: 'verified',
          processingStatus: 'unmatched',
        });
        expect(
          (await store.listReconciliationCandidates(10)).map((row) => row.evidenceId),
          'only webhook-kind evidence is a reconciliation candidate',
        ).toEqual([webhook.evidenceId]);
      });

      it('reviveUnmatchedEvidence (optional) clears the retry fields of unmatched webhook rows of the resource', async (store, ctx) => {
        if (typeof store.reviveUnmatchedEvidence !== 'function') {
          return;
        }
        const gaveUp = await insertEvidenceIn(store, ctx, {
          verificationStatus: 'verified',
          processingStatus: 'unmatched',
        });
        const otherResource = await store.insertEvidence({
          ...ctx,
          evidenceKind: 'webhook',
          providerEventId: uniqueId('evt'),
          rawPayload: '{}',
          payloadSha256: 'sha-conformance',
          eventType: 'BILLING.SUBSCRIPTION.ACTIVATED',
          resourceId: 'I-OTHER',
        });
        for (const row of [gaveUp, otherResource]) {
          await store.updateEvidence({
            evidenceId: row.evidenceId,
            verificationStatus: 'verified',
            processingStatus: 'unmatched',
            attempts: 100,
            retryStatus: 'gave_up',
          });
        }
        expect(
          await store.reviveUnmatchedEvidence({
            providerCode: ctx.providerCode,
            accountRef: ctx.accountRef,
            environment: ctx.environment,
            resourceId: 'I-CONFORMANCE',
          }),
          'reviveUnmatchedEvidence count',
        ).toBe(1);
        expect(
          (await store.listReconciliationCandidates(10)).map((row) => row.evidenceId),
          'revived row is a candidate again, the other resource is not',
        ).toEqual([gaveUp.evidenceId]);
      });

      it('claimPendingEvidence honours includePendingVerification', async (store, ctx) => {
        await insertEvidenceIn(store, ctx, {});
        const verified = await insertEvidenceIn(store, ctx, { verificationStatus: 'verified' });
        const claimed = await store.claimPendingEvidence({
          limit: 10,
          leaseMs: 60_000,
          workerId: 'w1',
          includePendingVerification: false,
        });
        expect(
          claimed.map((row) => row.evidenceId),
          'includePendingVerification false skips verification-pending rows',
        ).toEqual([verified.evidenceId]);
      });

      it('retry fields are stored by updateOperation and updateEvidence (undefined keeps, null clears)', async (store, ctx) => {
        const nextAttemptAt = '2030-01-01T00:00:00.000Z';
        const retryFields = (
          row: {
            attempts?: number | null;
            nextAttemptAt?: string | null;
            retryStatus?: string | null;
          } | null,
        ) => [
          row?.attempts ?? null,
          row?.nextAttemptAt ? new Date(row.nextAttemptAt).toISOString() : null,
          row?.retryStatus ?? null,
        ];
        const operation = await toUnknown(store, await createOperation(store, ctx));
        const deferred = await store.updateOperation({
          operationId: operation.operationId,
          expectedVersion: operation.version,
          attempts: 1,
          nextAttemptAt,
        });
        const kept = await store.updateOperation({
          operationId: deferred.operationId,
          expectedVersion: deferred.version,
          lifecycleReason: 'other field',
        });
        expect(retryFields(kept), 'operation attempts and nextAttemptAt kept').toEqual([
          1,
          nextAttemptAt,
          null,
        ]);
        const gaveUp = await store.updateOperation({
          operationId: kept.operationId,
          expectedVersion: kept.version,
          attempts: 2,
          nextAttemptAt: null,
          retryStatus: 'gave_up',
        });
        expect(
          retryFields(await store.findOperationById(gaveUp.operationId)),
          'operation gave_up stored',
        ).toEqual([2, null, 'gave_up']);
        const reset = await store.updateOperation({
          operationId: gaveUp.operationId,
          expectedVersion: gaveUp.version,
          attempts: null,
          retryStatus: null,
        });
        expect(retryFields(reset), 'operation retry fields cleared').toEqual([null, null, null]);

        const row = await insertEvidence(store, ctx);
        await store.updateEvidence({ evidenceId: row.evidenceId, attempts: 1, nextAttemptAt });
        await store.updateEvidence({ evidenceId: row.evidenceId, verificationStatus: 'verified' });
        expect(
          retryFields(await store.findEvidenceById(row.evidenceId)),
          'evidence attempts and nextAttemptAt kept',
        ).toEqual([1, nextAttemptAt, null]);
        await store.updateEvidence({
          evidenceId: row.evidenceId,
          attempts: 2,
          nextAttemptAt: null,
          retryStatus: 'gave_up',
        });
        expect(
          retryFields(await store.findEvidenceById(row.evidenceId)),
          'evidence gave_up stored',
        ).toEqual([2, null, 'gave_up']);
        await store.updateEvidence({
          evidenceId: row.evidenceId,
          attempts: null,
          retryStatus: null,
        });
        expect(
          retryFields(await store.findEvidenceById(row.evidenceId)),
          'evidence retry fields cleared',
        ).toEqual([null, null, null]);
      });

      it('listUncertainOperations lists stale submitted creates without provider reference (submittedStaleBefore)', async (store, ctx) => {
        const crashed = await claim(store, await createOperation(store, ctx));
        await pause(gapMs);
        const created = await claim(store, await createOperation(store, ctx));
        await store.transitionOperation({
          operationId: created.operationId,
          expectedVersion: created.version,
          nextStatus: 'submitted',
          providerReferenceId: uniqueId('I'),
          reason: 'created, awaiting approval',
        });
        const prepared = await createOperation(store, ctx);
        const leased = await createOperation(store, ctx);
        await store.acquireCheckoutCreateExecutionLease({
          operationId: leased.operationId,
          expectedVersion: leased.version,
        });
        await claim(store, await createOperation(store, ctx, { kind: 'payout_item' }));
        await pause(gapMs);
        const unknown = await toUnknown(store, await createOperation(store, ctx));
        const staleBefore = futureIso();
        expect(
          (await store.listUncertainOperations(10)).map((row) => row.operationId),
          'without submittedStaleBefore only unknown operations',
        ).toEqual([unknown.operationId]);
        expect(
          (await store.listUncertainOperations(10, { submittedStaleBefore: staleBefore })).map(
            (row) => row.operationId,
          ),
          'stale submitted subscription/checkout creates without reference or live lease',
        ).toEqual([crashed.operationId, unknown.operationId]);
        expect(
          (
            await store.listUncertainOperations(10, {
              submittedStaleBefore: new Date(Date.parse(crashed.updatedAt) - 60_000).toISOString(),
            })
          ).map((row) => row.operationId),
          'a submitted operation newer than submittedStaleBefore is not stale',
        ).toEqual([unknown.operationId]);
        expect(prepared.status).toBe('prepared');
      });
    });

    describe('consumer delivery fields', () => {
      it('persists and returns the consumer-delivery fields as written', async (store, ctx) => {
        const row = await insertEvidence(store, ctx, 'WH-CONSUMER');
        const read = async () => {
          const byId = await store.findEvidenceById(row.evidenceId);
          const byEvent = await store.findEvidenceByProviderEvent(
            ctx.providerCode,
            ctx.accountRef,
            ctx.environment,
            'WH-CONSUMER',
          );
          expect(byEvent?.consumerDeliveryStatus, 'findEvidenceByProviderEvent').toBe(
            byId?.consumerDeliveryStatus,
          );
          return [
            byId?.consumerDeliveryStatus,
            byId?.consumerDeliveryAttempts,
            byId?.consumerDeliveryLastError ?? null,
            byId?.consumerDeliveredAt ?? null,
          ];
        };
        await store.updateEvidence({
          evidenceId: row.evidenceId,
          verificationStatus: 'verified',
          processingStatus: 'processed',
          consumerDeliveryStatus: 'pending',
          consumerDeliveryAttempts: 0,
        });
        expect(await read()).toEqual(['pending', 0, null, null]);
        const claimed = await store.claimPendingEvidence({
          limit: 5,
          leaseMs: 60_000,
          workerId: 'w1',
        });
        expect(claimed[0]?.consumerDeliveryStatus, 'claimPendingEvidence').toBe('pending');
        await store.updateEvidence({
          evidenceId: row.evidenceId,
          consumerDeliveryStatus: 'failed',
          consumerDeliveryAttempts: 1,
          consumerDeliveryLastError: 'Consumer event delivery failed',
        });
        expect(await read()).toEqual(['failed', 1, 'Consumer event delivery failed', null]);
        await store.updateEvidence({
          evidenceId: row.evidenceId,
          consumerDeliveryStatus: 'failed_terminal',
          consumerDeliveryAttempts: 10,
        });
        expect(await read()).toEqual([
          'failed_terminal',
          10,
          'Consumer event delivery failed',
          null,
        ]);
        await store.updateEvidence({
          evidenceId: row.evidenceId,
          consumerDeliveryStatus: 'confirmed',
          consumerDeliveredAt: '2026-01-02T00:00:00.000Z',
          consumerDeliveryLastError: null,
        });
        expect(await read()).toEqual(['confirmed', 10, null, '2026-01-02T00:00:00.000Z']);
      });
    });

    describe('reconciliation attempts', () => {
      it('insertReconciliationAttempt stores the attempt', async (store, ctx) => {
        const evidence = await insertEvidence(store, ctx);
        const attempt = await store.insertReconciliationAttempt({
          evidenceId: evidence.evidenceId,
          outcome: 'no_op',
          resultCode: 'UNMATCHED',
        });
        expect(typeof attempt.attemptId).toBe('string');
        expect([
          attempt.evidenceId,
          attempt.outcome,
          attempt.resultCode,
          attempt.operationId ?? null,
        ]).toEqual([evidence.evidenceId, 'no_op', 'UNMATCHED', null]);
      });
    });

    if (capabilities.checkout) {
      describe('checkout capability', () => {
        it('implements every CheckoutStore method', async (store) => {
          expect(missingMethods(store, CHECKOUT_STORE_METHODS)).toEqual([]);
        });

        it('takes a create lease for a checkout and finds it by provider order id', async (store, ctx) => {
          const checkoutStore = store as unknown as SubscriptionStore & CheckoutStore;
          const created = await createOperation(store, ctx, {
            kind: 'checkout',
          });
          const lease = await checkoutStore.acquireCheckoutCreateExecutionLease({
            operationId: created.operationId,
            expectedVersion: created.version,
          });
          expect(lease.kind).toBe('acquired');
          const orderId = uniqueId('ORDER');
          await store.transitionOperation({
            operationId: lease.operation.operationId,
            expectedVersion: lease.operation.version,
            nextStatus: 'submitted',
            providerOrderId: orderId,
            reason: 'order created',
          });
          const found = await checkoutStore.findOperationByProviderOrderId(
            ctx.providerCode,
            ctx.accountRef,
            ctx.environment,
            orderId,
          );
          expect(found?.operationId).toBe(created.operationId);
        });
      });
    }

    if (capabilities.payout) {
      describe('payout capability', () => {
        it('implements every PayoutStore method', async (store) => {
          expect(missingMethods(store, PAYOUT_STORE_METHODS)).toEqual([]);
        });

        it('lists child operations by parent', async (store, ctx) => {
          const payoutStore = store as unknown as SubscriptionStore & PayoutStore;
          const batch = await createOperation(store, ctx, {
            kind: 'payout_batch',
          });
          const item = await createOperation(store, ctx, {
            kind: 'payout_item',
            parentOperationId: batch.operationId,
          });
          const children = await payoutStore.listOperationsByParent(batch.operationId);
          expect(children.map((row) => row.operationId)).toEqual([item.operationId]);
        });
      });
    }

    if (capabilities.seller) {
      describe('seller capability', () => {
        it('implements every SellerStore method', async (store) => {
          expect(missingMethods(store, SELLER_STORE_METHODS)).toEqual([]);
        });

        it('creates one connection per seller ref and updates it by version', async (store, ctx) => {
          const sellerStore = store as unknown as SubscriptionStore & SellerStore;
          const input = {
            ...ctx,
            sellerRef: uniqueId('seller'),
            trackingId: uniqueId('track'),
          };
          const first = await sellerStore.createSellerConnection(input);
          const again = await sellerStore.createSellerConnection(input);
          expect(again.connectionId).toBe(first.connectionId);
          await sellerStore.updateSellerConnection({
            connectionId: first.connectionId,
            expectedVersion: first.version,
            consentStatus: 'granted',
          });
          expectRejected(
            await rejectionOf(() =>
              sellerStore.updateSellerConnection({
                connectionId: first.connectionId,
                expectedVersion: first.version,
                consentStatus: 'revoked',
              }),
            ),
            PAYMENT_RELIABILITY_ERROR.TRANSITION_CONFLICT,
          );
        });
      });
    }

    if (capabilities.marketplace) {
      describe('marketplace capability', () => {
        it('implements every MarketplaceStore method', async (store) => {
          expect(missingMethods(store, MARKETPLACE_STORE_METHODS)).toEqual([]);
        });

        it('updates a purchase unit by version and finds it by capture id', async (store, ctx) => {
          const marketplaceStore = store as unknown as SubscriptionStore & MarketplaceStore;
          const checkout = await createOperation(store, ctx, {
            kind: 'marketplace_checkout',
          });
          const [unit] = await marketplaceStore.insertMarketplacePurchaseUnits([
            {
              operationId: checkout.operationId,
              referenceId: 'unit-1',
              sellerRef: 'seller-1',
              providerMerchantId: null,
              amountMinor: '1000',
              currencyCode: 'USD',
            },
          ]);
          if (!unit) {
            throw new Error('insertMarketplacePurchaseUnits returned no unit');
          }
          const captureId = uniqueId('CAP');
          await marketplaceStore.updateMarketplacePurchaseUnit({
            unitId: unit.unitId,
            expectedVersion: unit.version,
            unitStatus: 'captured',
            providerCaptureId: captureId,
          });
          expectRejected(
            await rejectionOf(() =>
              marketplaceStore.updateMarketplacePurchaseUnit({
                unitId: unit.unitId,
                expectedVersion: unit.version,
                unitStatus: 'failed',
              }),
            ),
            PAYMENT_RELIABILITY_ERROR.TRANSITION_CONFLICT,
          );
          expect(
            (await marketplaceStore.findMarketplacePurchaseUnitByCaptureId(captureId))?.unitId,
          ).toBe(unit.unitId);
        });
      });
    }
  });
}
