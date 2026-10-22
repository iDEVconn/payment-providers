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

class IgnoresConsumerDeliveryFlag extends MemoryPaymentReliabilityStore {
  override async claimPendingEvidence(input: ClaimPendingEvidenceInput) {
    return super.claimPendingEvidence({ ...input, includeConsumerDelivery: undefined });
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
      'drops subscriptionStateJson',
      () => new DropsSubscriptionStateJson(),
      /subscriptionStateJson/,
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
