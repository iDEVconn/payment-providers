# T5 review: store contract (#6, #21, #23, #24)

Verdict: **APPROVED_WITH_FIXES**

Gate observed: `npm run lint` clean, `npm run typecheck` clean, `npm run build` ok, `npm test` 101 files / 960 tests passed.

Flake loop: full suite 10x in a row, 10/10 green (960/960 each). Kit + broken-store tests 30x under 6 parallel loops (CPU load): 30/30 green (51/51).

Mutation experiments (scratch copy, memory store mutated, kit run against it): 20 mutations, all caught.
- transition without version check: 2 cases fail; updateOperation without version check: 1
- claim without version/status check: 2; claim TOCTOU (await between check and write): 1
- create ignoring fingerprint: 1; create TOCTOU: 1 (the 5 concurrent creates case)
- history drops transitionKind: 4
- evidence without duplicate check: 1; evidence insert TOCTOU: 1
- recovery lease ignores other workers: 2; lease never expires: 1; includeConsumerDelivery ignored: 1
- updateEvidence `processedAt` null ignored: 1; transition `failureCode` null ignored: 1
- provider-id silent overwrite: 2; uncertain list newest first: 1; reconciliation candidates reversed: 1
- write before `assertTransitionAllowed` (non-atomic): 1; create-lease TOCTOU: 1; consumer fields dropped: 2

Runtime export diff (pre-T5 snapshot dist vs current dist): nothing removed from `index`, `paypal`, `subscription` or `legacy`. Added to root: `DEFAULT_MAX_CONSUMER_DELIVERY_ATTEMPTS`, `OPERATION_TRANSITION_KIND`, `isAwaitingConsumerDeliveryOnly`, `toVerifiedProcessedPaymentEvent`; new `testing` entry (`runStoreConformance`). Declared type names: none removed. `PaymentReliabilityStore` keeps the same 46 methods, so store implementers get no new required methods.

Carry-over note: T5 concern 1 is already resolved. `ci.yml:47` lists `test/testing-entry-consumer.test.ts`.

## Findings

1. **important** (engine defect from before T5, now visible; T6). `reconciliation-service.ts:316` passes `evidence.resourceId` as `providerReferenceId`, and `:799-800` writes it as `providerSubscriptionId` on the subscription operation. For `PAYMENT.SALE.*` evidence related to an `unknown` subscription, the sale id replaces the `I-` id. The old memory store left stale index keys behind and hid this. The T5 store (and any SQL store) drops the key. Probe (`t5review/tools/p-sale.mjs`): pre-T5 `findBySubscriptionId(I-1)` returns the op; post-T5 it returns `null` and `providerSubscriptionId` is `SALE-1`. Later webhooks for `I-1` become `unmatched`. Smallest fix (T6): for subscription operations, take the subscription id from the operation (or from `billing_agreement_id`), never from a sale/payment resource id.

2. **important** (engine defect from before T5; T5 makes it part of the store contract; T6). An uncertain lifecycle command (`subscription_cancel` / `suspend` / `activate`) can never reconcile. `reconcileOperation` binds `providerReferenceId = I-…`, which the subscription operation already holds, so every run gives `RETRYABLE`, "Provider reference is already bound to a different operation". Output is the same before and after T5 (probe `t5review/tools/p-cancel.mjs`). T5's JSDoc and README now require `providerReferenceId` to be unique across kinds, so every conforming SQL store reproduces this. Smallest fix (T6): do not write `providerReferenceId` / `providerSubscriptionId` back onto command-kind operations in reconciliation.

3. **important** (kit demands more than the contract). `run-store-conformance.ts:880-899` "two concurrent workers get disjoint rows" asserts `ids.length === 4`, which only `FOR UPDATE SKIP LOCKED` gives. A correct, exclusive store that does SELECT then a conditional per-row `UPDATE … WHERE lease free` fails with "expected 2 to be 4" (reproduced in the copy). Smallest fix: assert disjointness only (`new Set(ids).size === ids.length`, each id among the inserted ones). Optionally follow with a sequential claim by a third worker that picks up the rest, so no row is lost.

4. **minor** (kit timing). `run-store-conformance.ts:109-110, 901-938`: the default lease is `leaseExpiryWaitMs / 4` = 50 ms. A correct store with a 60 ms round trip fails "a lease held by one worker is not claimable…" ("expected 1 to be +0"). Probe: a Proxy store with simulated latency passes at 30 ms and fails at 60 ms. A hosted Postgres (Supabase) is in that range. Smallest fix: default lease of about 1 s with the wait set to lease + margin (or a separate `leaseMs` option), and name network latency, not only clock skew, in the option JSDoc and README (T7 carry-over 3).

5. **minor** (README wrong). In README.md "Recovery" → "No consumer", the sentence "a store that returns them anyway gets them counted as `skipped` and released" reads as harmless. The T5 report says "ignoring it is safe". Neither is true: the oldest delivery-only rows fill every batch and starve newer work. Probe `t5review/probe-copy/p-starve.mjs`: 3 runs of `recover(limit 3)`, all `skipped`, and the new verified row stays `pending`. The kit already enforces the flag. Fix: say the flag is required, and why.

6. **minor**. The JSDoc at `src/contracts/lib/evidence.ts:14-16` says a host "may reset it to `failed` to retry". But `payment-recovery-service.ts:203-209` puts the row straight back to `failed_terminal` without delivering while `consumerDeliveryAttempts >= cap`. The README correctly says "and the attempts below the cap". Fix the JSDoc to match.

7. **minor** (feature detection). `store-capabilities.ts:51-55`: one missing or misspelled method silently turns its whole family into `unsupported`. That status is terminal and is acked to PayPal, so the events are lost with no signal. The opposite case: throwing stubs, which a 0.2.x subscriptions-only host had to write to satisfy the 46-method interface, count as "present", and those events keep failing. Smallest fix: the `WebhookProcessingService` / `ReconciliationService` constructors throw `PaymentConfigurationError` when a family is partly present, and the README says "delete stub methods, do not throw-stub them".

8. **minor**. `claimPendingEvidence` order: `run-store-conformance.ts:850-877` asserts the exact order of the returned rows. In Postgres, `UPDATE … RETURNING` does not keep the subquery's `ORDER BY`. The README / JSDoc should say to sort after `RETURNING` (CTE + outer `ORDER BY`). The same note should say that the concurrent cases only prove something when the store uses at least 2 connections. `Promise.all` on one client runs the calls one after another, and on the memory store each call runs atomically.

9. **minor**. `provider-execution-transition.ts:9-12`: any non-null `transitionKind` other than the two known values (for example an enum or mapping bug in a host store) turns off the structural fallback. The create retry then stays blocked. This fails safe: no second POST, and the operation stays `unknown`. Probe `t5review/probe-copy/p-kinds.mjs`, all 5 variants. Optional fix: treat unknown values like `null`.

10. **minor** (type-level change for hosts, changeset T7). `VerifiedProcessedPaymentEvent` gains the required `providerEventId` (`payment-event-consumer.ts:7-22`). Host code that builds these events (tests, fan-out) stops compiling. `ConsumerDeliveryStatus` is wider, which breaks exhaustive switches. List both in the changeset next to the `failed_terminal` column requirement.

Probe outputs and scripts: `/tmp/claude-1000/-home-vladimir-tkach-Projects-crawler-nx/7d726264-0747-4d01-8456-c621fc623f57/scratchpad/t5review/` (`mutations.txt`, `flake.txt`, `tools/`, `probe-copy/`, `probe-pre/`).
