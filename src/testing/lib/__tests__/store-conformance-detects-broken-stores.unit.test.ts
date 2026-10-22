import { describe, expect, it } from 'vitest';
import {
  PaymentReliabilityError,
  type PaymentOperation,
  type TransitionPaymentOperationInput,
  type UpdatePaymentOperationInput,
  type UpdateProviderEvidenceInput,
  type ProviderEvidenceRecord,
  type ClaimPendingEvidenceInput,
  type CreatePaymentOperationInput,
  type InsertProviderEvidenceInput,
} from '../../../contracts/index';
import { MemoryPaymentReliabilityStore } from '../../../core/lib/persistence/memory-payment-reliability-store';
import type { SubscriptionStore } from '../../../core/lib/persistence/payment-reliability-store';
import { runStoreConformance, type StoreConformanceCapabilities } from '../../index';

/*
 * The kit is only useful if it fails for stores that break a guarantee. Each broken store below
 * reproduces one deviation found in the issue #6 review (or a plausible SQL mistake); the kit must
 * report at least one failing case for it, and no failing case for the reference store.
 */

type CollectedCase = { name: string; run: () => Promise<void> | void };

function collectCases(
  createStore: () => SubscriptionStore,
  capabilities?: StoreConformanceCapabilities,
): CollectedCase[] {
  const cases: CollectedCase[] = [];
  const path: string[] = [];
  runStoreConformance({
    createStore,
    describe: (name, fn) => {
      path.push(name);
      fn();
      path.pop();
    },
    it: (name, fn) => {
      cases.push({ name: [...path, name].join(' > '), run: fn });
    },
    expect,
    capabilities,
    leaseExpiryWaitMs: 40,
  });
  return cases;
}

async function failingCases(
  createStore: () => SubscriptionStore,
  capabilities?: StoreConformanceCapabilities,
): Promise<string[]> {
  const failures: string[] = [];
  for (const testCase of collectCases(createStore, capabilities)) {
    try {
      await testCase.run();
    } catch {
      failures.push(testCase.name);
    }
  }
  return failures;
}

class DropsConsumerDeliveryFields extends MemoryPaymentReliabilityStore {
  override async updateEvidence(
    input: UpdateProviderEvidenceInput,
  ): Promise<ProviderEvidenceRecord> {
    const {
      consumerDeliveryStatus: _status,
      consumerDeliveredAt: _at,
      consumerDeliveryAttempts: _attempts,
      consumerDeliveryLastError: _error,
      ...rest
    } = input;
    return super.updateEvidence(rest);
  }
}

class ClaimWithoutTransitionKind extends MemoryPaymentReliabilityStore {
  override async transitionOperation(
    input: TransitionPaymentOperationInput,
  ): Promise<PaymentOperation> {
    return super.transitionOperation({ ...input, transitionKind: undefined });
  }
}

class IgnoresFingerprint extends MemoryPaymentReliabilityStore {
  override async createOperation(input: CreatePaymentOperationInput): Promise<PaymentOperation> {
    const existing = await this.findOperationByIdempotency(
      input.idempotencyScope,
      input.idempotencyKey,
    );
    return existing ?? super.createOperation(input);
  }
}

class NoVersionCheckOnUpdate extends MemoryPaymentReliabilityStore {
  override async updateOperation(input: UpdatePaymentOperationInput): Promise<PaymentOperation> {
    const current = await this.findOperationById(input.operationId);
    return super.updateOperation({
      ...input,
      expectedVersion: current?.version ?? input.expectedVersion,
    });
  }
}

class NewestUncertainFirst extends MemoryPaymentReliabilityStore {
  override async listUncertainOperations(limit: number): Promise<PaymentOperation[]> {
    return (await super.listUncertainOperations(Number.MAX_SAFE_INTEGER)).reverse().slice(0, limit);
  }
}

class FailureCodeCannotBeCleared extends MemoryPaymentReliabilityStore {
  override async transitionOperation(
    input: TransitionPaymentOperationInput,
  ): Promise<PaymentOperation> {
    return super.transitionOperation({
      ...input,
      failureCode: input.failureCode ?? undefined,
      failureMessage: input.failureMessage ?? undefined,
    });
  }
}

class LeaseIgnoringClaim extends MemoryPaymentReliabilityStore {
  override async claimPendingEvidence(input: ClaimPendingEvidenceInput) {
    const rows = await super.claimPendingEvidence(input);
    // Second worker steals rows the first one holds: release before every claim.
    for (const row of rows) {
      await super.updateEvidence({
        evidenceId: row.evidenceId,
        claimLeaseExpiresAt: null,
        claimWorkerId: null,
      });
    }
    return rows;
  }
}

class OverwritesProviderSubscriptionId extends MemoryPaymentReliabilityStore {
  override async transitionOperation(
    input: TransitionPaymentOperationInput,
  ): Promise<PaymentOperation> {
    try {
      return await super.transitionOperation(input);
    } catch (error) {
      if (error instanceof PaymentReliabilityError && input.providerSubscriptionId) {
        // Silently "wins" like a store without the partial unique index.
        return super.transitionOperation({
          ...input,
          providerSubscriptionId: undefined,
          providerReferenceId: undefined,
        });
      }
      throw error;
    }
  }
}

/** A store whose table has no `subscription_state_json` column (issue #4). */
class DropsSubscriptionStateJson extends MemoryPaymentReliabilityStore {
  override async createOperation(input: CreatePaymentOperationInput): Promise<PaymentOperation> {
    return super.createOperation({ ...input, subscriptionStateJson: undefined });
  }

  override async updateOperation(input: UpdatePaymentOperationInput): Promise<PaymentOperation> {
    return super.updateOperation({ ...input, subscriptionStateJson: undefined });
  }

  override async transitionOperation(
    input: TransitionPaymentOperationInput,
  ): Promise<PaymentOperation> {
    return super.transitionOperation({ ...input, subscriptionStateJson: undefined });
  }
}

/** A `jsonb` column read through a pg driver: the state comes back as an object, not text. */
class ReturnsSubscriptionStateAsObject extends MemoryPaymentReliabilityStore {
  private asJsonb(operation: PaymentOperation): PaymentOperation {
    return typeof operation.subscriptionStateJson === 'string'
      ? { ...operation, subscriptionStateJson: JSON.parse(operation.subscriptionStateJson) }
      : operation;
  }

  override async createOperation(input: CreatePaymentOperationInput): Promise<PaymentOperation> {
    return this.asJsonb(await super.createOperation(input));
  }

  override async updateOperation(input: UpdatePaymentOperationInput): Promise<PaymentOperation> {
    return this.asJsonb(await super.updateOperation(input));
  }

  override async findOperationById(operationId: string): Promise<PaymentOperation | null> {
    const operation = await super.findOperationById(operationId);
    return operation ? this.asJsonb(operation) : null;
  }
}

/** `consumer_delivery_status DEFAULT 'pending'`: every new row starts as a consumer delivery. */
class DefaultsConsumerDeliveryPending extends MemoryPaymentReliabilityStore {
  override async insertEvidence(
    input: InsertProviderEvidenceInput,
  ): Promise<ProviderEvidenceRecord> {
    const row = await super.insertEvidence(input);
    return super.updateEvidence({ evidenceId: row.evidenceId, consumerDeliveryStatus: 'pending' });
  }
}

class IgnoresConsumerDeliveryFlag extends MemoryPaymentReliabilityStore {
  override async claimPendingEvidence(input: ClaimPendingEvidenceInput) {
    return super.claimPendingEvidence({ ...input, includeConsumerDelivery: undefined });
  }
}

/** Ignores `nextAttemptAt` in every candidate list (deferred rows are selected at once). */
class IgnoresNextAttemptAt extends MemoryPaymentReliabilityStore {
  override async updateEvidence(input: UpdateProviderEvidenceInput) {
    return super.updateEvidence({ ...input, nextAttemptAt: undefined });
  }

  override async updateOperation(input: UpdatePaymentOperationInput) {
    return super.updateOperation({ ...input, nextAttemptAt: undefined });
  }
}

/** Has no `attempts` column: every attempt reads 0, so nothing ever gives up. */
class NeverIncrementsAttempts extends MemoryPaymentReliabilityStore {
  override async updateEvidence(input: UpdateProviderEvidenceInput) {
    return super.updateEvidence({ ...input, attempts: undefined });
  }

  override async updateOperation(input: UpdatePaymentOperationInput) {
    return super.updateOperation({ ...input, attempts: undefined });
  }
}

/** Has no `retry_status` column: a row that gave up is selected again forever. */
class NeverGivesUp extends MemoryPaymentReliabilityStore {
  override async updateEvidence(input: UpdateProviderEvidenceInput) {
    return super.updateEvidence({ ...input, retryStatus: undefined });
  }

  override async updateOperation(input: UpdatePaymentOperationInput) {
    return super.updateOperation({ ...input, retryStatus: undefined });
  }
}

class IgnoresPendingVerificationFlag extends MemoryPaymentReliabilityStore {
  override async claimPendingEvidence(input: ClaimPendingEvidenceInput) {
    return super.claimPendingEvidence({ ...input, includePendingVerification: undefined });
  }
}

/** Lists reconciliation's own evidence rows too (no `evidence_kind = 'webhook'` filter). */
class ListsReconciliationEvidence extends MemoryPaymentReliabilityStore {
  override async insertEvidence(
    input: Parameters<MemoryPaymentReliabilityStore['insertEvidence']>[0],
  ) {
    return super.insertEvidence({ ...input, evidenceKind: 'webhook' });
  }
}

/** A 0.2 store: `listUncertainOperations(limit)` without the stale `submitted` option. */
class NoStaleSubmittedOperations extends MemoryPaymentReliabilityStore {
  override async listUncertainOperations(limit: number) {
    return super.listUncertainOperations(limit);
  }
}

/**
 * Correct and exclusive, but without `SKIP LOCKED`: selects the claimable rows, then takes each one
 * with a conditional update that succeeds only while the lease is still free. Under concurrency a
 * worker can get fewer rows than `limit`; it never gets a row another worker holds.
 */
class SelectThenConditionalUpdate extends MemoryPaymentReliabilityStore {
  override async claimPendingEvidence(input: ClaimPendingEvidenceInput) {
    // "SELECT": the claimable rows, without holding them (lease of 0 ms expires immediately).
    const selected = await super.claimPendingEvidence({ ...input, leaseMs: 0 });
    const claimed: ProviderEvidenceRecord[] = [];
    for (const row of selected) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      const fresh = await this.findEvidenceById(row.evidenceId);
      const leaseFree =
        !fresh?.claimLeaseExpiresAt ||
        Date.parse(fresh.claimLeaseExpiresAt) <= Date.now() ||
        fresh.claimWorkerId === input.workerId;
      if (fresh && leaseFree) {
        claimed.push(
          await this.updateEvidence({
            evidenceId: row.evidenceId,
            claimWorkerId: input.workerId,
            claimLeaseExpiresAt: new Date(Date.now() + input.leaseMs).toISOString(),
          }),
        );
      }
    }
    return claimed;
  }
}

describe('runStoreConformance detects broken stores', () => {
  it('passes an exclusive store that claims by select then conditional update (no SKIP LOCKED)', async () => {
    expect(await failingCases(() => new SelectThenConditionalUpdate())).toEqual([]);
  });

  it('passes a store that returns subscriptionStateJson as a parsed jsonb object', async () => {
    expect(await failingCases(() => new ReturnsSubscriptionStateAsObject())).toEqual([]);
  });

  it('passes every case for the reference memory store', async () => {
    expect(
      await failingCases(() => new MemoryPaymentReliabilityStore(), {
        checkout: true,
        payout: true,
        seller: true,
        marketplace: true,
      }),
    ).toEqual([]);
  });

  it.each([
    [
      'drops the consumer-delivery fields',
      () => new DropsConsumerDeliveryFields(),
      /consumer-delivery/,
    ],
    [
      'records no transitionKind on a claim',
      () => new ClaimWithoutTransitionKind(),
      /claim_execution/,
    ],
    ['ignores the command fingerprint', () => new IgnoresFingerprint(), /fingerprint/],
    ['skips the version check on update', () => new NoVersionCheckOnUpdate(), /version/],
    ['lists uncertain operations newest first', () => new NewestUncertainFirst(), /oldest first/],
    ['cannot clear failureCode with null', () => new FailureCodeCannotBeCleared(), /null clears/],
    ['lets a second worker take a held lease', () => new LeaseIgnoringClaim(), /lease/],
    [
      'ignores includeConsumerDelivery',
      () => new IgnoresConsumerDeliveryFlag(),
      /includeConsumerDelivery/,
    ],
    [
      'silently ignores a provider subscription id bound elsewhere',
      () => new OverwritesProviderSubscriptionId(),
      /provider id/,
    ],
    [
      'defaults consumerDeliveryStatus to pending on insert',
      () => new DefaultsConsumerDeliveryPending(),
      /new row has no consumerDeliveryStatus/,
    ],
    [
      'drops subscriptionStateJson',
      () => new DropsSubscriptionStateJson(),
      /subscriptionStateJson/,
    ],
    ['ignores nextAttemptAt', () => new IgnoresNextAttemptAt(), /nextAttemptAt/],
    ['never increments attempts', () => new NeverIncrementsAttempts(), /retry fields/],
    ['never gives up', () => new NeverGivesUp(), /oldest first by nextAttemptAt/],
    [
      'ignores includePendingVerification',
      () => new IgnoresPendingVerificationFlag(),
      /includePendingVerification/,
    ],
    [
      'lists reconciliation-kind evidence as candidates',
      () => new ListsReconciliationEvidence(),
      /only webhook evidence/,
    ],
    [
      'never lists stale submitted creates',
      () => new NoStaleSubmittedOperations(),
      /submittedStaleBefore/,
    ],
  ])('fails a store that %s', async (_label, createStore, expectedCase) => {
    const failures = await failingCases(createStore);
    expect(failures.length).toBeGreaterThan(0);
    expect(
      failures.some((name) => expectedCase.test(name)),
      failures.join('\n'),
    ).toBe(true);
  });

  it('fails a declared capability whose methods are missing', async () => {
    const failures = await failingCases(() => new MemoryPaymentReliabilityStore(), {
      checkout: true,
    });
    expect(failures).toEqual([]);
    const subscriptionOnly = () => {
      const backing = new MemoryPaymentReliabilityStore();
      const store = Object.create(backing) as Record<string, unknown>;
      store.findOperationByProviderOrderId = undefined;
      return store as unknown as SubscriptionStore;
    };
    const missing = await failingCases(subscriptionOnly, { checkout: true });
    expect(missing.some((name) => /checkout/.test(name))).toBe(true);
  });
});
