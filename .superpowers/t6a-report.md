# T6a report: engine on the pure core (#4), T5 review bugs 1+2, payload hash on resume

Status: DONE_WITH_CONCERNS (nothing blocks; concerns at the end). Nothing committed, no git state changed.

Gate: `npm run lint && npm run typecheck && npm run build && npm test` green, **104 files / 987 tests** (baseline 101 / 965; +3 files, +22 tests).
Tests first: all 22 new tests were run before the implementation and failed (missing exports, `unsupported` UPDATED, sale id written as the subscription id, command never reconciled, no hash check, kit case, executor fields), then went green. The recovery-redelivery test was added later and also seen failing first.
No existing test was changed. `tsc -p tsconfig.test.json` shows only the pre-existing errors in `test/public-exports.unit.test.ts` and `test/package-consumer.test.ts`.

## Files changed by T6a (diff -rq against .superpowers/snap-after-t5/)

New:
- src/core/lib/__tests__/subscription-core-wiring.unit.test.ts
- src/core/lib/__tests__/reconciliation-subscription-core.unit.test.ts
- src/core/lib/__tests__/webhook-payload-hash-resume.unit.test.ts

Edited:
- src/contracts/lib/operations.ts, src/contracts/lib/subscription.ts
- src/core/lib/subscription-evidence-application.ts, src/core/lib/webhook-processing-service.ts, src/core/lib/reconciliation-service.ts
- src/core/lib/subscription-lifecycle-service.ts, src/core/lib/subscription-transition-policy.ts, src/core/lib/subscription-provider-snapshot-fields.ts
- src/core/lib/persistence/memory-payment-reliability-store.ts, src/core/lib/persistence/payment-reliability-store.ts (JSDoc only)
- src/paypal/lib/paypal-subscription-executor.ts, src/paypal/lib/__tests__/paypal-subscription-executor.unit.test.ts
- src/testing/lib/run-store-conformance.ts, src/testing/lib/__tests__/store-conformance-detects-broken-stores.unit.test.ts
- README.md

## What was done

### 1. Engine on the pure core (single source of truth)
- `subscription-evidence-application.ts`: new `applySubscriptionEvents(store, { operation, steps, evidenceId, reason, holdEffects })`. It reads the stored `SubscriptionState` (`readSubscriptionOperationState`: columns + `subscriptionStateJson`), runs each step through `reduceSubscription`, and persists the result with one write (update, or transition when the execution status changes), retrying on version conflicts with the fresh row. The old ordering/duplicate rules (`applySubscriptionTransitionOnce`, `isDuplicateSubscriptionEvidence`) are deleted; the public `applySubscriptionTransition` is now a thin adapter that builds one event and calls `applySubscriptionEvents` (all its existing tests pass unchanged).
- Helpers: `normalizeSubscriptionEvidencePayload` (normaliser; a body without its own `id`, accepted at intake with a host id, is read with the evidence's provider event id), `subscriptionEventFromProviderSnapshot` (GET result -> reducer event), `resolveExpectedSubscriptionPayment`.
- `WebhookProcessingService`: every `BILLING.SUBSCRIPTION.*`, `PAYMENT.FAILED` and `PAYMENT.SALE.*` goes through one `processSubscriptionEvidence`: normalise, correlate by the event's subscription id (`billing_agreement_id` for sales), reduce, persist, deliver effects. With a lookup, status events apply the snapshot (ordered by the snapshot's state time, as before; missing billing fields fall back to the body); payment events never trigger a lookup. Removed: `processSubscriptionWebhook`, `processSubscriptionPaymentEvidence`, `resolveBillingAgreementId`, `findCorrelatedSubscriptionOperation`, the plan-consistency and snapshot-field helpers' use.
- `ReconciliationService`: subscription evidence = payment event step (if any) + lookup step (`source: 'lookup'`), or the event alone when no lookup is available; uncertain subscription ops = lookup step. Correlation of subscription evidence uses the normalised body (sales by `billing_agreement_id`). Removed the subscription branches of `lookupProviderOutcome` / `applyReconciliationOutcome`, `applySubscriptionReconciliationOutcome`, `resolveReconciliationSubscriptionStatus` and the subscription fields of `ReconciliationOutcome`.
- `paypal-subscription-executor.ts`: `getSubscription` also returns `lastPayment`, `failedPaymentsCount`, `outstandingBalance` (via `normalizePaypalSubscriptionResource`); the local loose timestamp parser now delegates to the core's `parseProviderTimestamp`.
- `evaluateSubscriptionProviderStateOrdering`, `parseSubscriptionResourceStateTimestamp`, `subscriptionBillingFieldsFromProviderSnapshot` are no longer used by the engine: kept (public) and marked `@deprecated`.

### 2. #4 persisted state, checks
- Contract (additive): `PaymentOperation.subscriptionStateJson?: string | null`, also on create/update/transition inputs; `ExecuteGetSubscriptionResult` gains optional `lastPayment`, `failedPaymentsCount`, `outstandingBalance`.
- Stored: status, plan, watermark (`providerSubscriptionStateAt`, legacy `providerTransactionId` cleared as before), `nextBillingTime`, `startTime` in their columns; `subscriptionStateJson` = `{version:1, lastPayment, failedPaymentsCount, lastEventId, recentEventIds, recentSaleIds, pendingEffects}`.
- `MemoryPaymentReliabilityStore` stores it (undefined keeps, null clears). Kit case "subscriptionStateJson is stored by create, update and transition"; broken-store test `DropsSubscriptionStateJson` fails it. README "Implementing a store" and the store JSDoc document the column.
- Plan-id mismatch without lookup: the reducer compares the event plan with the stored `providerPlanId`.
- Expected price: `createBillingPlan` now stores the lowest positive cycle price / setup fee on the plan operation's existing `amountMinor`/`currencyCode`; sale checks use the subscription's own columns, else the parent plan's.
- `PAYMENT.SALE.COMPLETED` records `lastPayment` (and the sale id); `PAYMENT.FAILED` raises `failedPaymentsCount`; refunds/reversals and mismatches surface as effects.

### 3. Effects hook
- `SubscriptionEffectsHooks = { onSubscriptionEffects?(operationId, effects, context) }` as new last constructor parameter of `WebhookProcessingService` (4th) and `ReconciliationService` (3rd). Called after the state is persisted. `context`: `evidenceId, eventType, source ('webhook'|'reconciliation'), decision, reason, operation`.
- Loss-free on hook failure: when a hook is configured, effects of a state-changing event are written into `subscriptionStateJson.pendingEffects` (keyed by evidence id, bounded 16) in the same write as the state, and removed after the hook returns. If the hook throws, the evidence stays `pending` with `SUBSCRIPTION_EFFECTS_HOOK_FAILED` (static message, no host error text); reprocessing (redelivery, `reprocessStoredWebhookEvidence`, `PaymentRecoveryService`) delivers the same held effects again. Reconciliation rows (not webhook events) are redelivered by the webhook service through a small `redeliverHeldSubscriptionEffects` path. Noop effects (mismatches) are not held: reprocessing recomputes them. Documented in README.

### 4. T6 MUST DO bug 1 (sale id overwrite)
Reconciliation never takes ids from the evidence resource for subscriptions; `applySubscriptionEvents` only fills `providerSubscriptionId` / `providerReferenceId` when the operation has none (reference only on `subscription` kind) and never replaces them; the reducer rejects an event for another subscription id. p-sale ported; the original probe now prints `providerSubscriptionId I-1 providerReferenceId I-1`, both lookups find the op, and a later CANCELLED webhook is processed.

### 5. T6 MUST DO bug 2 (command reconcile)
`reconcileSubscriptionCommand`: looks up the subscription id of the parent subscription operation, applies the lookup to the parent (reducer, `source: 'lookup'`), and moves the command to `succeeded` (target status reached) or `failed` with `SUBSCRIPTION_COMMAND_NOT_APPLIED`. Nothing is written onto the command op except status/failure fields. p-cancel ported; the original probe now prints `applied 1`, command `succeeded`, subscription `cancelled`, reference still bound to the subscription.

### 6. Payload hash on resume (T3 review 7)
`handleExistingEvidence` compares `sha256Payload(rawBody)` with the stored `payloadSha256` first (also for already processed rows and the insert race); a mismatch throws `WebhookEventPayloadMismatchError` (subclass of `PaymentReliabilityError`, code `INVALID_REQUEST`) before verify or any write. Tests: pending row, processed row, same body resumes.

Recheck probes (`scratchpad/t6a-probe/`, p2/p2b/p3 adapted to the T3 intake rule: no host event id that differs from the body id) all show the expected results (#2 a-d hold, #4 lookup plan mismatch pending, no-lookup plan mismatch now pending, 0.01 JPY sale not recorded, getSubscription returns the billing fields).

## Rulings
- Ruling: `subscriptionStateJson` holds only the reducer fields without a column (+ pending effects); column-backed fields stay in their columns (the lifecycle service writes columns only), so there is one place per field.
- Ruling: a write happens only for a material change (status, ids, plan, watermark, billing dates, last payment, failed count, recent sale ids) or an execution-status change; a change of only the recent webhook ids writes nothing (evidence is already unique per provider event id). Keeps the existing "repeated CANCELLED does not bump the version" test.
- Ruling: plan-mismatch noop (event or lookup would grant access on another plan) leaves webhook evidence `pending` with `SUBSCRIPTION_PLAN_MISMATCH` (same as the old lookup path) and gives a `terminal_failure` attempt in reconciliation (as before); the `plan_mismatch` effect still goes to the hook.
- Ruling: amount/currency mismatch: evidence `processed`, state unchanged, effect to the hook.
- Ruling: expected price = lowest positive cycle price or setup fee (a priced trial or a setup fee must not be reported as underpayment); mixed currencies store none. Subscriptions created via `providerPlanId` (no plan op) get only the plan-id check.
- Ruling: a webhook body that cannot be normalised (no subscription id, invalid JSON) is `unmatched` (as before for a missing id).
- Ruling: `BILLING.SUBSCRIPTION.UPDATED` without a lookup is applied from its resource (status + billing fields) instead of `unsupported`.
- Ruling: an uncertain command whose subscription did not reach the target status is `failed` (`SUBSCRIPTION_COMMAND_NOT_APPLIED`), not left `unknown`; the host re-issues it with a new key. A lookup that fails or has no recognised status leaves it retryable.
- Ruling: execution status is synced to the subscription status on applied events and on `transition_rejected`/`duplicate_event` noops (old behaviour), not on ordering or mismatch noops.
- Ruling: the payload-hash error is a `PaymentReliabilityError` subclass with the existing `INVALID_REQUEST` code, so the `PaymentReliabilityErrorCode` union does not widen.
- Ruling: reconciliation lookups now advance the watermark when the snapshot carries a newer state time (reducer `lookup` rule); they never move it back.

## Behaviour changes for hosts
- Store column: `subscriptionStateJson` (nullable text/jsonb) must be persisted and returned (optional in the type; a store without it loses last payment/failed count and may re-deliver effects). Run the kit.
- `BILLING.SUBSCRIPTION.UPDATED` without a lookup is now `processed` (was `unsupported`).
- An ACTIVATED/APPROVED event (or lookup) on another plan than the stored one no longer activates; evidence `pending`, `SUBSCRIPTION_PLAN_MISMATCH` (was applied when no lookup was configured).
- `PAYMENT.SALE.*` / `PAYMENT.FAILED` now change the stored state (version bumps) and produce effects.
- `createBillingPlan` sets `amountMinor`/`currencyCode` on the plan operation.
- Uncertain cancel/suspend/activate commands now reach `succeeded`/`failed` in reconciliation (were stuck `RETRYABLE`); their execution status no longer mirrors the subscription status.
- A redelivery with a known event id but a different body throws `WebhookEventPayloadMismatchError` (`INVALID_REQUEST`); was resumed/acked.
- Subscription evidence processed after an earlier error now has `errorCode`/`errorMessage` cleared.
- `applySubscriptionTransition` (public) runs through the reducer: it no longer overwrites an existing `providerSubscriptionId`/`providerReferenceId`, and an input plan different from the stored one blocks access like a webhook.
- Reconciliation of subscription evidence whose lookup fails and whose event carries no status is now `retryable` (was "applied" with the stored status).
- New root exports (additive): `applySubscriptionEvents`, `readSubscriptionOperationState`, `deliverSubscriptionEffects`, `clearPendingSubscriptionEffects`, `readHeldSubscriptionEffects`, `normalizeSubscriptionEvidencePayload`, `subscriptionEventFromProviderSnapshot`, `resolveExpectedSubscriptionPayment`, `SUBSCRIPTION_EFFECTS_HOOK_FAILED`, `SUBSCRIPTION_COMMAND_NOT_APPLIED`, `WebhookEventPayloadMismatchError` and the hook/step types.

## Concerns
1. Plan-mismatch evidence stays `pending` and `PaymentRecoveryService` reprocesses it on every run, so the hook sees `plan_mismatch` each time until the host adopts the plan. T6b's attempt cap / `gave_up` should bound this.
2. Effects of reconciliation rows whose hook failed are redelivered by the webhook service's hook (via recovery): hosts must give both services the same hook (README says so).
3. The root export surface grows by several engine helpers (`export *` of the module); T7 may want to narrow them to an explicit list.
4. `mapPaypalProductStatus` (carry-over note) has no counterpart in the pure core (products are not subscription state); left as is.
5. Formatting: new test files and `subscription-evidence-application.ts` (prettier-clean before) were formatted with a local prettier 3.9.10 (`--single-quote --trailing-comma all --print-width 100`); other edited files were hand-formatted, my hunks checked against that prettier (unions kept in the repo's leading-`|` style).

## Commit message
```
feat(subscription): run engine on the pure core, persist billing state

- WebhookProcessingService, ReconciliationService and the evidence
  application normalise and reduce subscription events with the pure
  core (normalizePaypalSubscriptionEvent, reduceSubscription); the
  duplicated ordering rules in the engine are gone.
- Persist next billing time, start time, last payment, failed payment
  count and the reducer's dedupe ids (new nullable
  subscriptionStateJson on operations; memory store, conformance kit
  case and README). Plan mismatch is detected without a lookup; sales
  are checked against the plan price that createBillingPlan now
  stores; PAYMENT.SALE.* and PAYMENT.FAILED change state.
- Optional onSubscriptionEffects host hook, called after the state is
  saved; a throwing hook keeps the evidence retryable and the effects
  are held and delivered again.
- Reconciliation never takes the subscription id from a sale resource,
  and uncertain cancel/suspend/activate commands reconcile through
  their subscription instead of binding its reference.
- A known webhook event id with a different body is rejected
  (WebhookEventPayloadMismatchError) before any processing.
- getSubscription returns last payment, failed count and outstanding
  balance.

Refs #4

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
```

## Fix wave (review .superpowers/t6a-review.md, findings 1-7; 8 is T7)

Gate: `npm run lint && npm run typecheck && npm run build && npm test` green, **105 files / 998 tests** (before the wave: 104 / 987).
Tests first: the new file `src/core/lib/__tests__/subscription-state-fix-wave.unit.test.ts` (ports of p-revise, p-jsonb, p-cap2, plus the lifecycle path), the new kit test for a jsonb-object store, and the changed payload-code assertion were run first and failed (12 failures), then went green. Reviewer probes against the new build: p-revise hook calls `['plan_mismatch']` once in 3 recovery runs; p-jsonb object and reformatted text both keep `failedPaymentsCount 2` and the last payment; p-cap2 delivers `status_changed,period_updated` (status active); p-cap and the T5 probes p-sale and p-cancel are unchanged.

Changed-files delta (compared with the first T6a hand-over):
- new: src/core/lib/__tests__/subscription-state-fix-wave.unit.test.ts
- newly edited: src/contracts/lib/reliability-errors.ts, src/core/lib/subscription-provider-plan-consistency.ts (deprecation JSDoc), src/core/lib/__tests__/subscription-lifecycle-service.unit.test.ts
- edited again: src/contracts/lib/operations.ts, src/core/lib/subscription-evidence-application.ts, src/core/lib/webhook-processing-service.ts, src/core/lib/reconciliation-service.ts, src/core/lib/subscription-lifecycle-service.ts, src/testing/lib/run-store-conformance.ts, src/testing/lib/__tests__/store-conformance-detects-broken-stores.unit.test.ts, src/core/lib/__tests__/webhook-payload-hash-resume.unit.test.ts, src/core/lib/__tests__/subscription-core-wiring.unit.test.ts, README.md

1. Lifecycle commands: after a successful cancel/suspend/activate, `runSubscriptionLifecycle` applies the provider result with `applySubscriptionEvents` (one `subscriptionEventFromProviderSnapshot` step, `source: 'lookup'`). This gives the plan rule (a cancellation on another plan applies and reports `plan_mismatch`), the watermark that never moves back, last payment and failed count, and hook effects (new optional 3rd constructor parameter `hooks`, `context.source: 'lifecycle'`). A hook failure throws `SUBSCRIPTION_EFFECTS_HOOK_FAILED` after the state is saved; the effects are held under `command:<commandOperationId>`, and replaying the same idempotency key delivers them. `SUBSCRIPTION_PLAN_MISMATCH` is returned only when the mismatch blocked access. `applySubscriptionDomainUpdate` and `assertSubscriptionProviderPlanSnapshotConsistent` are `@deprecated` and no longer have production callers.
2. Plan adoption: new exported `adoptSubscriptionPlan({ store, operationId, providerPlanId, amountMinor?, currencyCode?, webhookProcessing? })` does one CAS write of the plan and the expected price, and forgets the remembered mismatches. It returns `pendingEvidenceIds` and, when given `webhookProcessing`, reprocesses those rows. A `plan_mismatch` that keeps a row pending is recorded after the hook accepted it (`planMismatches` in the state, key = evidence id; reconciliation lookups key by `lookup:<plan>`) and is not delivered again for that row. README: exact delivery guarantee plus a "Plan revision / adopting a new plan" section.
3. `subscriptionStateJson`: the read type is `string | Record<string, unknown> | null`, and the parser accepts text or object. Unreadable content throws `SUBSCRIPTION_STATE_UNREADABLE`; nothing is applied or rewritten and the webhook evidence stays `pending` with that code (reconciliation records a retryable failure). `readSubscriptionOperationState` throws too. The kit compares parsed content (deep equality). New kit test: a store returning a jsonb object passes. The store that drops the field still fails.
4. Held effects are never evicted. When 16 batches are held, the new row is not applied and stays `pending` with `HELD_EFFECTS_OVERFLOW`; it is applied after the backlog drains (reconciliation: retryable attempt). `deliverSubscriptionEffects` never reports success for undelivered held effects: without a hook the row stays `pending` with `SUBSCRIPTION_EFFECTS_HOOK_MISSING`, and such rows are redelivered once a hook is configured.
5. Expected-price limits (priced trial or setup fee; a price lowered at PayPal) are documented in the README and in the JSDoc of `expectedPlanPayment` and `resolveExpectedSubscriptionPayment`.
6. State version: `version` > 1 throws `SUBSCRIPTION_STATE_VERSION_UNSUPPORTED` (fail closed, no rewrite, evidence pending). Unknown fields of version 1 are kept on rewrite. A missing or invalid version, or a wrong field type, is `SUBSCRIPTION_STATE_UNREADABLE`.
7. `WebhookEventPayloadMismatchError` now has its own code `WEBHOOK_PAYLOAD_MISMATCH` (added to `PAYMENT_RELIABILITY_ERROR`, along with `SUBSCRIPTION_STATE_UNREADABLE`, `SUBSCRIPTION_STATE_VERSION_UNSUPPORTED` and `SUBSCRIPTION_EFFECTS_HOOK_FAILED`). README: the raw body must arrive byte for byte; the error is permanent for that delivery (answer non-2xx, fix the transport); a row stored before verification needs a byte-identical PayPal redelivery.

Rulings (fix wave)
- Ruling: plan-mismatch rows are remembered only when a hook is configured (only then is there something to deliver once). This keeps the existing "no write on a mismatched snapshot" test. Without a hook, `adoptSubscriptionPlan` returns no ids and recovery reprocesses the pending rows.
- Ruling: overflow does not apply the event instead of applying it without a hold. Nothing is lost; the row waits.
- Ruling: lifecycle overflow returns `subscriptionStateRefreshPending: true` with `HELD_EFFECTS_OVERFLOW` (the later webhook applies the change).
- Ruling: the remembered plan-mismatch list is bounded at 32 rows. Older rows can be reported once more (at least once, never zero).

Behaviour changes for hosts (added by the fix wave)
- A cancellation, suspension or activation through `SubscriptionLifecycleService` now applies the provider state through the reducer. A cancel whose snapshot is on another plan is applied (it was refused with `SUBSCRIPTION_PLAN_MISMATCH`). The watermark never moves back, and the hook receives effects. The test "keeps lifecycle command success when post-refresh plan id mismatches stored plan" encoded the old refusal and was changed. The persistence-failure test now spies `applySubscriptionEvents`.
- `PaymentReliabilityErrorCode` gains `WEBHOOK_PAYLOAD_MISMATCH`, `SUBSCRIPTION_STATE_UNREADABLE`, `SUBSCRIPTION_STATE_VERSION_UNSUPPORTED` and `SUBSCRIPTION_EFFECTS_HOOK_FAILED`, which breaks exhaustive switches. The payload-mismatch error is no longer `INVALID_REQUEST`.
- New evidence codes `HELD_EFFECTS_OVERFLOW` and `SUBSCRIPTION_EFFECTS_HOOK_MISSING` (rows stay `pending`).
- `PaymentOperation.subscriptionStateJson` read type widened to include an object.
- New exports: `adoptSubscriptionPlan` (+ types), `HELD_EFFECTS_OVERFLOW`, `SUBSCRIPTION_EFFECTS_HOOK_MISSING`, `SubscriptionEffectsDelivery`, `StoredEvidenceReprocessor`.

Remaining concern: T6b's attempt cap should still bound rows that stay `pending` (plan mismatch, overflow, missing hook); they are retried by every recovery run, but no longer re-deliver `plan_mismatch`.

### Updated commit message (whole T6a)
```
feat(subscription): run engine on the pure core, persist billing state

- WebhookProcessingService, ReconciliationService, the evidence
  application and the lifecycle command refresh normalise and reduce
  subscription state with the pure core (reduceSubscription); the
  duplicated ordering and plan rules in the engine are gone
  (applySubscriptionDomainUpdate and
  assertSubscriptionProviderPlanSnapshotConsistent deprecated).
- Persist next billing time, start time, last payment, failed payment
  count and the reducer's dedupe ids in a new nullable
  subscriptionStateJson (text or jsonb; read fails closed on corrupt
  or newer-version content; memory store, kit case and README).
- Plan mismatch is detected without a lookup and never grants access;
  adoptSubscriptionPlan accepts a revised plan and price and
  reprocesses the pending rows. Sales are checked against the plan
  price createBillingPlan now stores; PAYMENT.SALE.* and
  PAYMENT.FAILED change state.
- Optional onSubscriptionEffects host hook on the webhook,
  reconciliation and lifecycle services, called after the state is
  saved: at least once per row, effects held until accepted, never
  evicted (HELD_EFFECTS_OVERFLOW), plan_mismatch once per pending row.
- Reconciliation never takes the subscription id from a sale resource,
  and uncertain cancel/suspend/activate commands reconcile through
  their subscription instead of binding its reference.
- A known webhook event id with a different body is rejected with
  WEBHOOK_PAYLOAD_MISMATCH before any processing.
- getSubscription returns last payment, failed count and outstanding
  balance.

Refs #4

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
```

## Final fix wave (final whole-branch review, .superpowers/final-review.md: F3, F4, F7, F9, F10, F12, F13)

State: T1-T7 committed by the owner as `81c513f`; this wave is uncommitted on top (second commit). README.md, `.changeset/*` and `.superpowers/pr-body.md` were not touched by me (the docs agent edits them in parallel; their diff in `git diff HEAD` is not mine).

Gate: `npm run lint && npm run typecheck && npm run build && npm test` green, **112 files / 1099 tests** (baseline 111 / 1090). Tests first: the new file `src/core/lib/__tests__/final-review-fix-wave.unit.test.ts` (6), the F7 runtime test, the F13 assertion, the new kit case and its broken-store test were run first. 7 failed; the kit case passed on the memory store, and the broken store fails it as intended. Then all green. F13: in a scratch copy the lookup id was changed to `evidence.resourceId ?? ...` (mutation #4e). The p-sale test now fails ("never takes the subscription id from a PAYMENT.SALE resource"); before, the mutant survived. Reviewer probes against the new build: probes2 [C] null delivery column gives `pending`, `delivered 1`; [D] same-second CANCELLED: `cancelled` with a lookup; without one the receipt is `unmatched` and `reconcile` gives `applied 1`, `cancelled`; [E] forged types stored as null/null; ddl-probes [B] throws `PaymentConfigurationError`.

My files in this wave (`git diff HEAD --stat` minus README/changeset, plus 2 new files):
- src/contracts/lib/recovery.ts (+ optional `deliveryFailed`)
- src/core/index.ts (exports `SUBSCRIPTION_STATE_CONFLICT_EQUAL_TIMESTAMP`)
- src/core/lib/payment-recovery-service.ts, reconciliation-service.ts, resolve-payment-runtime.ts, subscription-evidence-application.ts, subscription-lifecycle-service.ts, webhook-evidence-resume.ts, webhook-processing-service.ts
- new src/core/lib/subscription-evidence-events.ts (engine-internal, not exported)
- src/testing/lib/run-store-conformance.ts, src/testing/lib/__tests__/store-conformance-detects-broken-stores.unit.test.ts
- tests: new src/core/lib/__tests__/final-review-fix-wave.unit.test.ts; edited reconciliation-subscription-core, resolve-payment-runtime, payment-recovery-consumer-delivery (exact summary now has `deliveryFailed: 0`)
- test/fixtures/export-surface/root.json (pins refreshed with `UPDATE_EXPORT_SURFACE=1`, runtime then declarations; diff reviewed: -`DEFAULT_WEBHOOK_MAX_TRANSMISSION_SKEW_MS`, +`SUBSCRIPTION_STATE_CONFLICT_EQUAL_TIMESTAMP`, nothing else)

What changed
- F3: `markFinancialProcessed` and `isConsumerDeliveryComplete` treat `null` like `undefined` (`== null`). Kit case: "a new row has no consumerDeliveryStatus, and a processed reconciliation row is never claimed for delivery" (webhook and reconciliation inserts read back null/absent; a processed reconciliation row is not claimed). Broken store `DefaultsConsumerDeliveryPending` (the DDL default) fails it. Engine test with a store wrapper that maps undefined to null: the processed webhook row becomes `pending` and is delivered once; the reconciliation lookup row is never delivered.
- F4: steps get `lookupOnEqualConflict`; the webhook lookup branch sets it, so at an `equal_conflict` the snapshot is reduced again as `source: 'lookup'` and wins. Without a lookup the row is not marked processed: `processingStatus: 'unmatched'`, `errorCode: SUBSCRIPTION_STATE_CONFLICT_EQUAL_TIMESTAMP`, `relatedOperationId` set. Reconciliation then lists it and applies its lookup (`applied 1`, status cancelled, row processed); without a usable lookup it records a retryable attempt and leaves the row. The pure reducer and its `equal_conflict` vector are unchanged.
- F7: production refuses missing credentials whenever reject-only is refused, also with a configured `executionStatus` and checkout disabled. `missingFields` names only the credentials when a status is given. Kill switch and `allowRejectOnlyInProduction` are unchanged (existing tests pass).
- F9: intake stores `event_type` / `resource.id` only when they are strings, else null.
- F10: removed `DEFAULT_WEBHOOK_MAX_TRANSMISSION_SKEW_MS` (new in this branch, unused) and the identical ternary in `verificationFailureKind`. `isSubscriptionEvidenceEvent` now lives once in the new non-exported `subscription-evidence-events.ts`. Kept: `subscriptionBillingFieldsFromProviderSnapshot`, because it was exported by 0.2.1 (`v021/src/core/index.ts:44`), stays `@deprecated`. The other deprecated 0.2.1 symbols are kept as well.
- F12: a consumer failure right after a row was processed in the same recovery run counts as `processed` plus `deliveryFailed` (new optional counter, always set by the service), not `failed`. Attempts, backoff and `failed_terminal` are unchanged. A failure in the delivery-only branch is still counted `failed` (the existing ack-write test pins it).
- F13: the p-sale test asserts every `getSubscription` call uses `I-1`.

Rulings
- Ruling (F4): "stays pending with a distinct code" is implemented as `unmatched` + `SUBSCRIPTION_STATE_CONFLICT_EQUAL_TIMESTAMP`. Without a store-contract change, `unmatched` is the only state that is both retried by recovery and listed by `listReconciliationCandidates`, so reconciliation can repair the row. A `pending` row whose operation is not `unknown` is never a reconciliation candidate.
- Ruling (F10): `subscriptionBillingFieldsFromProviderSnapshot` existed in published 0.2.1, so under the "only symbols new in this branch" rule it stays (deprecated), although the review listed it.
- Ruling (F12): `deliveryFailed` is optional in the type so host code that builds `RecoverPaymentReliabilityResult` keeps compiling.

Docs needed (for the docs agent)
- Store contract / DDL: `consumer_delivery_status` must have no default (new kit case); the engine now treats SQL `NULL` like an absent value (F2/F3).
- Webhook flow / Known limits: a status at the same provider second as the stored one with another status is settled by the provider lookup (webhook lookup branch, reconciliation). Without a lookup the row is `unmatched` with `SUBSCRIPTION_STATE_CONFLICT_EQUAL_TIMESTAMP` until reconciliation runs.
- Recovery: new `deliveryFailed` counter in the `recover()` result (rows processed in the run whose consumer delivery failed; also counted in `processed`).
- Changeset: `DEFAULT_WEBHOOK_MAX_TRANSMISSION_SKEW_MS` is gone (never released); new root export `SUBSCRIPTION_STATE_CONFLICT_EQUAL_TIMESTAMP`; `RecoverPaymentReliabilityResult.deliveryFailed?`; production now throws for missing credentials also with a configured `executionStatus` and checkout disabled (README `:314` becomes exact).
- F8: `recordReconciliationFailure` still classifies by message text (`'Terminal operation status'`, pre-existing). README `:996` should not claim the package itself never matches message text.
- README `maxTransmissionSkewMs` row (`:880`) is unaffected (the option stays; only the unused constant went).

### Commit message (second commit)
```
fix(engine): final review fixes for delivery nulls, same-second status, prod credentials

- Treat a null consumerDeliveryStatus like an absent one, so SQL stores
  with a nullable column still deliver processed webhooks and never
  deliver reconciliation rows; the conformance kit pins that a new row
  has no delivery status (a column default of 'pending' fails it).
- A status at the same provider second as the stored one with another
  status is settled by the provider lookup (webhook lookup branch and
  reconciliation); without a lookup the row stays unmatched with
  SUBSCRIPTION_STATE_CONFLICT_EQUAL_TIMESTAMP instead of processed.
- Production refuses missing credentials also with a configured
  executionStatus and checkout disabled.
- Intake stores only string event types and resource ids.
- Recovery reports a consumer failure after processing as
  deliveryFailed, not failed.
- Pin that reconciliation looks up the subscription id, not the sale
  id; drop the unused DEFAULT_WEBHOOK_MAX_TRANSMISSION_SKEW_MS and a
  duplicated helper.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
```
