# T5 report: store contract (issues #6, #23, #24, #21)

Status: DONE_WITH_CONCERNS (nothing blocks; concerns at the end). Nothing committed, no git state changed.

Gate: `npm run lint && npm run typecheck && npm run build && npm test`: green, **101 files / 960 tests** (baseline 94 / 877).
New tests were run before the fixes and failed (11 failures plus 3 files that could not import missing modules). The kit was also run against the pre-T5 memory store (snapshot copy, temporary test, deleted afterwards): 9 of 41 cases failed, each at a deviation fixed below.

## Files changed by T5 (diff -rq against .superpowers/snap-after-t4/)

New:
- src/core/lib/persistence/store-capabilities.ts
- src/core/lib/provider-execution-transition.ts
- src/testing/index.ts, src/testing/lib/run-store-conformance.ts
- src/testing/lib/__tests__/store-conformance-memory.unit.test.ts
- src/testing/lib/__tests__/store-conformance-detects-broken-stores.unit.test.ts
- src/core/lib/__tests__/subscription-store-only.unit.test.ts
- src/core/lib/__tests__/claim-transition-kind.unit.test.ts
- src/core/lib/__tests__/payment-recovery-consumer-delivery.unit.test.ts
- src/core/lib/__tests__/store-contract-exports.unit.test.ts
- test/testing-entry-consumer.test.ts

Edited:
- src/contracts/lib/operations.ts, src/contracts/lib/evidence.ts, src/contracts/lib/recovery.ts
- src/core/lib/persistence/payment-reliability-store.ts, src/core/lib/persistence/memory-payment-reliability-store.ts
- src/core/lib/webhook-processing-service.ts, src/core/lib/reconciliation-service.ts, src/core/lib/payment-recovery-service.ts,
  src/core/lib/payment-event-consumer.ts, src/core/lib/subscription-lifecycle-service.ts, src/core/lib/checkout-lifecycle-service.ts,
  src/core/lib/webhook-evidence-resume.ts
- src/core/lib/{payout-evidence-application,payout-webhook-correlation,seller-connection-reconciliation,seller-evidence-application,marketplace-evidence-application,subscription-evidence-application}.ts (parameter types narrowed only)
- src/core/lib/__tests__/payment-recovery-service.unit.test.ts (one test encoded #21, see below)
- test/dist-declarations.test.ts, test/dist-entry-identity.test.ts, test/dist-package-surface.test.ts, test/entries-consumer.test.ts (add `testing` to the entry lists)
- package.json (`exports["./testing"]`, `typesVersions.testing`), tsup.config.ts (`testing` entry), README.md

Not touched: `.github/`, `package-lock.json`, tsup `splitting`, `./legacy`.

## What was done

### #6 store split + subscriptions-only host
- `payment-reliability-store.ts`: capability interfaces `OperationStore`, `CreateExecutionLeaseStore`, `SubscriptionOperationLookupStore`, `EvidenceStore`, `ReconciliationStore`, composite `SubscriptionStore`, plus `CheckoutStore`, `PayoutStore`, `SellerStore`, `MarketplaceStore`, `EvidenceAdminStore`. `PaymentReliabilityStore` extends all of them (same 46 methods). Every guarantee is documented in JSDoc next to the method (error codes, CAS, one winner under concurrency, patch rules, unique indexes, ORDER BY). All exported from root (via the existing `export *`).
- `store-capabilities.ts`: method lists per optional capability and guards `hasCheckoutStore/hasPayoutStore/hasSellerStore/hasMarketplaceStore` (feature detection: every method of the interface is a function).
- Services take the narrowest type: `SubscriptionLifecycleService` → `SubscriptionLifecycleStore = OperationStore & CreateExecutionLeaseStore`; `WebhookProcessingService` → `WebhookProcessingStore = SubscriptionStore & Partial<Checkout & Payout & Seller & Marketplace>`; `ReconciliationService` → `ReconciliationServiceStore = SubscriptionStore & Partial<Payout & Seller & Marketplace>`; `PaymentRecoveryService` → `EvidenceStore`. Helpers take only what they call.
- Without a capability: webhooks of that family (payout, seller, checkout/capture/refund, marketplace) are stored `unsupported`; `reprocessVerifiedUnmatchedPayoutEvidence` returns zeros; reconciliation does not list seller connections, payout/seller evidence correlates to nothing (UNMATCHED no-op), and an operation of a missing family gets a `no_op` attempt `STORE_CAPABILITY_NOT_CONFIGURED`.
- Test `subscription-store-only.unit.test.ts`: a store object with exactly the 20 `SubscriptionStore` methods (list written by hand, asserts 21 non-subscription methods are absent) runs create, webhooks (subscription applied, 4 other families `unsupported`), reconciliation of an `unknown` subscription (never calls the seller listing) and recovery + delivery.

### Conformance kit `@idevconn/payment-providers/testing`
- `runStoreConformance({ createStore, destroyStore?, describe, it, expect, capabilities?, leaseExpiryWaitMs?, orderingGapMs? })`. No runner dependency: `expect` is typed structurally (`toBe`, `toEqual`, optional message). 37 core cases + 2 per declared capability: idempotency (replay, fingerprint conflict, 5 concurrent creates), version CAS (update, transition), claim (`claim_execution`, two concurrent claims one winner + OPERATION_CONFLICT, non-prepared), create lease (one acquired of two, `claim_execution`/`claim_retry`, `not_eligible`), transition+history (one row with reason/evidenceId/transitionKind, null kind, rejected transition writes nothing, owner mismatch, concurrent transitions one applied), provider ids (same-kind rebind rejected via transition/update/create, reference unique across kinds, kind and environment scoped lookups, null frees the id), patch semantics (update, failure fields, reference exception, evidence), evidence uniqueness (incl. concurrent), recovery lease (workerId, recoverable rows oldest first, `includeConsumerDelivery`, two workers disjoint, held lease + expiry), ORDER BY of both candidate lists, consumer-delivery fields round trip (findById, findByProviderEvent, claim), reconciliation attempt.
- Tests: kit runs against `MemoryPaymentReliabilityStore` (all capabilities); `store-conformance-detects-broken-stores` runs the kit with a collecting runner against 8 broken stores (drops consumer fields, no transitionKind, ignores fingerprint, no version check, newest-first uncertain list, failureCode cannot be cleared, lease ignored, silent provider-id overwrite) and a store missing a declared checkout method: each fails at least the expected case; the reference store fails none.
- Entry: tsup `testing`, `exports["./testing"]` (import/require/types), `typesVersions.testing`; `test/testing-entry-consumer.test.ts` loads ESM/CJS, runs the full kit from dist with a 10-line hand-written runner under ESM and CJS (0 failures, no vitest/jest in `require.cache`) and type-checks a consumer under node10 and node16 (verified node10 fails with TS2307 without `typesVersions.testing`). Added `testing` to the dist surface, identity (no axios/zod/express/@idevconn/payment), declarations and entries-consumer tests.

### Memory store fixes (decided per case)
- Provider ids: `providerReferenceId` (any kind) and `providerSubscriptionId`/`providerPlanId`/`providerProductId`/`providerReferralId` (their kind) are now unique per provider/account/environment in `createOperation`, `updateOperation` and `transitionOperation` (`TRANSITION_REJECTED`, `provider_reference_bound`), before any write. Was: silent index overwrite (only the reference was checked, only in transitions).
- Index entries are removed when an id is cleared or changed (a cleared id no longer finds the row).
- `transitionOperation`: `failureCode`/`failureMessage` now `null` clears (was `??`); `providerReferenceId` keeps on `null` (documented exception). All checks run before the write and the history row; the method no longer awaits between check and write.
- `updateEvidence`: `eventType`, `resourceId`, `processedAt`, `errorCode`, `errorMessage` follow undefined-keeps / null-clears (`processedAt: null` used by the webhook path was silently ignored before).
- History rows store `transitionKind` (`null` when absent); claim writes `claim_execution`, the lease `claim_execution` from prepared and `claim_retry` otherwise.
- `listReconciliationCandidates` ORDER BY `receivedAt, evidenceId`; `listUncertainOperations` ORDER BY `createdAt, operationId` (oldest first; was insertion order). `claimPendingEvidence` honours `includeConsumerDelivery: false`.

### #23 typed claim kind
- `OperationTransitionKind = 'claim_execution' | 'claim_retry'`, `OPERATION_TRANSITION_KIND`, optional `transitionKind` on `TransitionPaymentOperationInput` and `PaymentOperationTransitionRecord`.
- `resolveFirstProviderExecutionAt` (new module) replaces both services' reason comparisons: earliest `claim_execution`, or, for rows without a kind, the structural `prepared -> submitted` move. The two `'Claimed for provider execution'` constants are gone; a static test fails if any core module compares `.reason ===` or contains that literal.
- p6b ported: a store whose claim writes another reason text, with and without `transitionKind`, still retries an `unknown` create (2 provider calls, `submitted`, `SUB-1`).

### #24 consumer delivery
- `maxConsumerDeliveryAttempts` (default `DEFAULT_MAX_CONSUMER_DELIVERY_ATTEMPTS` = 10, validated integer >= 1, `PaymentConfigurationError`); the failure that reaches the cap writes `failed_terminal`; a row already at the cap is marked terminal without delivering. `ConsumerDeliveryStatus` gains `'failed_terminal'`; `isConsumerDeliveryComplete` treats it as finished, so it is not claimed again and a webhook redelivery is acked as duplicate.
- Consumer gets `toVerifiedProcessedPaymentEvent(row)`: evidenceId, providerCode, accountRef, applicationRef, environment, providerEventId (new), eventType, resourceId, relatedOperationId, processingStatus, verificationStatus; `rawPayload` only with `includeRawPayload: true`. Was: the whole stored row at runtime.
- At-least-once documented (JSDoc on `PaymentEventConsumer`, dependency docs, README) and tested (failed ack write → second delivery, then confirmed). Field contract documented on `ProviderEvidence` and `EvidenceStore.updateEvidence`, covered by the kit case and its broken-store test.
- p7 ported (always-throwing consumer stops at the cap; default cap 10).

### #21 no consumer
- `recover()` passes `includeConsumerDelivery: consumer !== null`; delivery-only rows are not claimed. `delivered` counts only acknowledged deliveries; rows a store returns anyway (ignores the flag) are counted `skipped` and released. p5b ported: 30 processed rows, 3 runs of `recover(25)` → all zeros, rows stay `pending`, no lease left.

### README
New "Implementing a store" section (capability table, what runs with `SubscriptionStore`, every guarantee, kit example), `/testing` entry row, consumer delivery (narrowed event, at-least-once, cap, terminal status and how to reset it), recovery counters and no-consumer behaviour. T7 owns polishing.

## Test changed because it encoded a defect
- `payment-recovery-service.unit.test.ts` "respects recovery batch limit": it claimed delivery-only rows with `consumer: null` (#21). It now wires a consumer so it still checks the limit.

## Rulings
- Ruling: `SubscriptionStore` includes `acquireCheckoutCreateExecutionLease` (subscription create retry uses it) and `findOperationByProviderProductId` (catalog products are part of the subscription service); `listOperationsByParent` is in `PayoutStore`, `findLatestReconciliationEvidenceForResource` in `MarketplaceStore` (only marketplace uses it), `listProviderEvidenceForRecovery` in `EvidenceAdminStore`.
- Ruling: a webhook family the store cannot handle is `unsupported` (terminal, not re-reconciled), not `unmatched`.
- Ruling: claim identification falls back to the structural `prepared -> submitted` move when a row has no `transitionKind`, so existing host stores and rows written by 0.2.x keep working (p6b without kind passes).
- Ruling: provider ids of checkout/capture/refund/payout stay non-unique (a capture carries its order id); documented as "latest write wins".
- Ruling: a transition keeps `providerReferenceId` on `null` (webhooks pass a possibly-null resource id; unbinding by transition would be a new hazard).
- Ruling: `updateEvidence` keeps no version check; documented that the recovery lease serialises writers (CAS on evidence was not in the task list).
- Ruling: `isRecoverableEvidenceRow` now uses `isConsumerDeliveryComplete`, so processed rows without delivery fields (legacy) are no longer claimed every run (they were "delivered" without a call before).
- Ruling: claim conflict code is `OPERATION_CONFLICT` (memory store behaviour, now required by the kit); version conflicts on update/transition are `TRANSITION_CONFLICT`.
- Ruling: an acknowledgement-write failure counts as a failed attempt (it rethrows through the same path).
- Ruling: the kit requires an empty store per case (`createStore`), since list/ordering methods read the whole store; cases also use a unique `accountRef`.
- Ruling: no new `RecoverPaymentReliabilityResult` field; the no-consumer case is explained by `claimed: 0` (flag honoured) or `skipped` (flag ignored).

## Behaviour changes for existing store implementers / hosts
- Store columns must accept `consumer_delivery_status = 'failed_terminal'` (a CHECK constraint with three values would reject the write) and persist the new `transitionKind` on history rows (optional: without it, the structural fallback applies).
- `claimPendingEvidence` receives `includeConsumerDelivery` and MUST honour it (corrected in the fix wave: a store that ignores it fills every no-consumer batch with delivery-only rows, which are counted `skipped`, and newer verified rows starve).
- `ConsumerDeliveryStatus` union widened: an exhaustive `switch` in host code needs a new case.
- Consumers no longer receive `rawPayload` or other row internals unless `includeRawPayload: true`.
- `MemoryPaymentReliabilityStore` now raises where a unique index would (tests that bound one provider id to two operations would now fail; none in this repo did).
- `recover().delivered` counts only acknowledged deliveries.

## Concerns
1. `test/testing-entry-consumer.test.ts` is not in the CI "Package smoke tests" step T4 added (I was told not to touch `.github/`); it runs in `npm test` anyway. Add it there if the step is meant to list every entry smoke test.
2. Conformance cases that wait for lease expiry use the test-process clock against `claimLeaseExpiresAt`; a SQL store using the database clock may need a larger `leaseExpiryWaitMs` (documented on the option).
3. Kit concurrency cases use `Promise.all` on one store object; against a real database they prove one-winner semantics only if the store uses separate connections/transactions per call (README says to run it against a real database).
4. T6 will change candidate ordering to `nextAttemptAt`; the kit's ordering cases and the JSDoc then need updating together.
5. Prettier is not a dependency of this repo; new and edited files were formatted with a local prettier 3.8.3 (`--single-quote --trailing-comma all --print-width 100`), matching the existing files, without network. Two shared files (webhook-processing-service.ts, reconciliation-service.ts) were not prettier-clean before T5; only my hunks were checked, they are clean.

## Commit message
```
feat(store): capability store interfaces, conformance kit, typed claims, bounded consumer delivery

- Split PaymentReliabilityStore into capability interfaces (OperationStore,
  EvidenceStore, ReconciliationStore, SubscriptionStore composite, checkout,
  payout, seller, marketplace); the old name stays the union. Lifecycle,
  webhook, reconciliation and recovery services run with a SubscriptionStore
  and feature-detect the other capabilities instead of calling missing
  methods.
- New @idevconn/payment-providers/testing entry: runStoreConformance with the
  host's describe/it/expect (no runner dependency) covering idempotency,
  version CAS, claims, transition history, provider-id uniqueness, patch
  semantics, evidence uniqueness, leases, candidate ordering and the
  consumer-delivery fields. The memory store now passes it: unique provider
  ids, null clears failure and evidence fields, oldest-first lists.
- Claims carry a typed transitionKind (claim_execution / claim_retry);
  create retries no longer depend on the store's free-text reason.
- Consumer delivery: maxConsumerDeliveryAttempts (default 10) then
  failed_terminal, narrowed event without rawPayload unless
  includeRawPayload, at-least-once documented; recover() without a consumer
  claims no delivery-only rows and reports delivered 0.

Refs #6, #21, #23, #24

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
```

## Fix wave (review .superpowers/t5-review.md, findings 3-9; 1-2 are T6, 10 is T7)

Gate: `npm run lint && npm run typecheck && npm run build && npm test` green, **101 files / 965 tests** (before the wave: 960).
Tests first: the 4 new tests that target behaviour failed before the fixes (select-then-update store vs. the kit, unknown `transitionKind`, partial family at construction, partial family after construction). The new broken-store case for an ignored `includeConsumerDelivery` already passed, because the kit enforced the flag (it pins that).

3. Kit "two concurrent workers": asserts only that the two claimed sets are disjoint and come from the inserted rows; a third worker then claims the rest, and every row is claimed exactly once. New test: `SelectThenConditionalUpdate`, a correct, exclusive store without SKIP LOCKED (it selects, then takes each row with a conditional update), passes every kit case.
4. Kit lease: new option `leaseMs` (default `DEFAULT_CONFORMANCE_LEASE_MS` = 1000), `leaseExpiryWaitMs` kept (default `leaseMs` + `DEFAULT_CONFORMANCE_LEASE_MARGIN_MS` = 500; with only the wait given, the lease is half of it; wait <= lease throws). JSDoc and README name store round-trip latency and clock skew. Both constants are exported from `/testing`.
5. README ("Implementing a store" and "Recovery"), the `includeConsumerDelivery` JSDoc (contract + `claimPendingEvidence`) and this report now say the flag is required, and why (starvation). Broken-store test `IgnoresConsumerDeliveryFlag` fails the kit.
6. `ConsumerDeliveryStatus` JSDoc: to retry, set `failed` AND lower `consumerDeliveryAttempts` below the cap; while the count is at the cap, recovery re-marks the row `failed_terminal` without delivering (matches `payment-recovery-service.ts`).
7. Capability detection: a family is present with all its methods and absent with none. Partial → `PaymentConfigurationError` naming the family, with `missingFields` = the missing methods. Thrown by the `WebhookProcessingService` and `ReconciliationService` constructors (`assertStoreCapabilitiesComplete`), and by the guards at first use if the store changed after construction (the webhook is then not acked as `unsupported`; the evidence stays retryable). `acquireCheckoutCreateExecutionLease` was removed from `CHECKOUT_STORE_METHODS` (it is part of `SubscriptionStore`, so it would make every subscription store look "partly checkout"). README: implement only the families you use and delete throwing stub methods. Tests: both cases (partial at construction; partial added later), and the existing "no methods → unsupported" test.
8. JSDoc on `claimPendingEvidence` + README: in Postgres, `UPDATE ... RETURNING` does not keep the subquery order, so sort after RETURNING (CTE + outer ORDER BY). A conditional per-row update may return fewer than `limit` rows. Kit `createStore` JSDoc + README: the concurrency cases need a pool with at least two connections; `Promise.all` over one client serialises the calls.
9. `isProviderExecutionClaimTransition`: only `claim_execution` (true) and `claim_retry` (false) are trusted; any other value falls back to the structural `prepared -> submitted` rule, as for `null`. Test added.

Rulings (fix wave)
- Ruling: partial-family detection lives in the guards themselves, so both construction and first use are covered with one rule; `SubscriptionLifecycleService` and `PaymentRecoveryService` do not check (they use no optional family).
- Ruling: with only `leaseExpiryWaitMs` given (old callers), the lease is half of the wait, which keeps the in-repo broken-store harness fast (40 ms wait).

Files changed in the fix wave (delta against the state at the end of the first pass):
src/testing/lib/run-store-conformance.ts, src/testing/index.ts, src/testing/lib/__tests__/store-conformance-detects-broken-stores.unit.test.ts,
src/core/lib/persistence/store-capabilities.ts, src/core/lib/persistence/payment-reliability-store.ts, src/core/lib/provider-execution-transition.ts,
src/core/lib/webhook-processing-service.ts, src/core/lib/reconciliation-service.ts, src/contracts/lib/evidence.ts, src/contracts/lib/recovery.ts,
src/core/lib/__tests__/claim-transition-kind.unit.test.ts, src/core/lib/__tests__/subscription-store-only.unit.test.ts, README.md. No new files.

### Updated commit message (whole T5)
```
feat(store): capability store interfaces, conformance kit, typed claims, bounded consumer delivery

- Split PaymentReliabilityStore into capability interfaces (OperationStore,
  EvidenceStore, ReconciliationStore, SubscriptionStore composite, checkout,
  payout, seller, marketplace); the old name stays the union. Lifecycle,
  webhook, reconciliation and recovery services run with a SubscriptionStore
  and feature-detect the other families (all methods or none); a partly
  implemented family throws PaymentConfigurationError instead of acking
  its events as unsupported.
- New @idevconn/payment-providers/testing entry: runStoreConformance with the
  host's describe/it/expect (no runner dependency) covering idempotency,
  version CAS, claims, transition history, provider-id uniqueness, patch
  semantics, evidence uniqueness, lease exclusivity and expiry (1 s default
  lease), candidate ordering, includeConsumerDelivery and the
  consumer-delivery fields. The memory store now passes it: unique provider
  ids, null clears failure and evidence fields, oldest-first lists.
- Claims carry a typed transitionKind (claim_execution / claim_retry);
  create retries no longer depend on the store's free-text reason, and
  unknown kinds fall back to the prepared -> submitted rule.
- Consumer delivery: maxConsumerDeliveryAttempts (default 10) then
  failed_terminal, narrowed event without rawPayload unless
  includeRawPayload, at-least-once documented; recover() without a consumer
  claims no delivery-only rows and reports delivered 0.

Refs #6, #21, #23, #24

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
```
