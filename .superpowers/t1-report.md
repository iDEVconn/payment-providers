# T1 report: pure subscription core (`@idevconn/payment-providers/subscription`)

Status: DONE (fix wave applied, see the end). Nothing committed (owner rule received mid-task: no `git commit` / `git push`). All changes are in the working tree.

## Verification

`npm run lint && npm run typecheck && npm run build && npm test`: all green. **82 files / 566 tests passed** (baseline 77 / 439; +5 files, +127 tests). No existing test was changed except for additions (see below).

Tests written first and seen failing (missing modules; new policy assertion `suspended -> approval_pending` failed against the old rule) before the implementation.

## What was built

New folder `src/subscription-core/` (entry `src/subscription-core/index.ts`):

- `lib/subscription-core-types.ts`: public types.
- `lib/subscription-money.ts`: ISO 4217 exponent table + decimal -> minor units by string arithmetic.
- `lib/subscription-status-rules.ts`: status mapping, transition guard, timestamp parsing, ordering, freshness. Single source of truth.
- `lib/normalize-paypal-subscription-event.ts`: webhook and lookup normalisers, `deriveProviderEventId`.
- `lib/reduce-subscription.ts`: `initialSubscriptionState`, `reduceSubscription`.

Runtime imports: only files inside `subscription-core`; `contracts` only via `import type`. Built `dist/subscription.js` imports one shared chunk (`chunk-*.js` with the status rules, also used by `index.js`); `dist/subscription.cjs` is self-contained. Loading it via CJS loads no `axios`/`zod`/`express`/`@idevconn/payment` (tested).

### Public API (entry `./subscription`)

```ts
normalizePaypalSubscriptionEvent(rawBody: string): NormalizeSubscriptionEventResult
  // { ok: true; event: NormalizedSubscriptionEvent } | { ok: false; reason: 'invalid_json'|'not_an_object'|'missing_event_id'|'missing_event_type'|'unsupported_event_type'|'missing_resource'|'missing_subscription_id' }
normalizePaypalSubscriptionResource(rawBody: string): NormalizeSubscriptionEventResult   // GET subscription body -> event for source 'lookup'
deriveProviderEventId(rawBody: string): string | null
isFreshTransmission(transmissionTime: string | null | undefined, now: Date | number, maxSkewMs: number): boolean
reduceSubscription(state: SubscriptionState, event: NormalizedSubscriptionEvent, options: ReduceSubscriptionOptions): ReduceSubscriptionResult
initialSubscriptionState(overrides?: Partial<SubscriptionState>): SubscriptionState
parseDecimalToMinorUnits(value: string, currency: string): string | null
currencyMinorUnitExponent(currency: string): number
parseProviderTimestamp(value: unknown): string | null
compareProviderStateTimestamps(stored: string | null, incoming: string): 'older'|'newer'|'equal'
evaluateSubscriptionStateOrdering({ currentStatus, storedStateAt, desiredStatus, incomingStateAt, authoritative }): SubscriptionStateOrderingDecision
isSubscriptionStatusTransitionAllowed(current, next): boolean
resolveSubscriptionStatusTransition(current, next): SubscriptionStatus
isTerminalSubscriptionStatus(status): boolean
mapPaypalSubscriptionStatus, mapSubscriptionWebhookEventToStatus, isSubscriptionWebhookProviderRefreshEvent, isSubscriptionPaymentEvidenceEvent
SUBSCRIPTION_LOOKUP_EVENT_TYPE ('paypal.subscription.lookup'), SUBSCRIPTION_PAYMENT_FAILED_EVENT_TYPE, SUBSCRIPTION_SALE_EVENT_TYPES
types: NormalizedSubscriptionEvent, NormalizeSubscriptionEventResult, NormalizeSubscriptionEventFailureReason, SubscriptionState,
       ReduceSubscriptionOptions ({ expectedPlanId?, expectedPayment?: { amountMinor; currency }, source: 'webhook'|'lookup' }),
       ReduceSubscriptionResult ({ state, decision: 'applied'|'noop', reason?, effects }), ReduceSubscriptionNoopReason,
       SubscriptionEffect, SubscriptionEffectType, SubscriptionMoney, SubscriptionLastPayment, SubscriptionSalePayment,
       SubscriptionEventResourceType, SubscriptionStatus (re-export)
```

`NormalizedSubscriptionEvent` fields: `providerEventId, eventType, resourceType ('subscription'|'sale'), providerSubscriptionId, providerPlanId, providerStatus (raw), subscriptionStatus (implied), stateAt, nextBillingTime, startTime, lastPayment {amountMinor,currency,time}, failedPaymentsCount, outstandingBalance, payment {amountMinor,currency,saleId} (sales only), eventTime`.

Effects (plain data): `status_changed {from,to}`, `payment_completed {amountMinor,currency,saleId,time}`, `payment_failed {failedPaymentsCount,outstandingBalance}`, `plan_mismatch {expectedPlanId,actualPlanId}`, `amount_mismatch {expected,actual,saleId}`, `currency_mismatch {expectedCurrency,actualCurrency,saleId}`, `refund_or_reversal {eventType,amountMinor,currency,saleId}`, `period_updated {nextBillingTime,startTime}`.

Noop reasons: `duplicate_event, subscription_mismatch, plan_mismatch, amount_mismatch, currency_mismatch, stale, equal_conflict, missing_timestamp, transition_rejected` (`unsupported_event_type` is in the union for forward use, never returned today).

### One source of truth

`src/core/lib/subscription-transition-policy.ts` now imports from `subscription-core/lib/subscription-status-rules` and re-exports `mapPaypalSubscriptionStatus`, `mapSubscriptionWebhookEventToStatus`, `isSubscriptionWebhookProviderRefreshEvent`, `isSubscriptionPaymentEvidenceEvent`, `resolveSubscriptionStatusTransition` under the same names (root exports unchanged). `assertSubscriptionTransitionAllowed`, `evaluateSubscriptionProviderStateOrdering` and `parseSubscriptionResourceStateTimestamp` delegate to the core (same signatures, same error messages; plain `Error` kept for T2 to replace). The local `compareProviderStateTimestamps` and `SUBSCRIPTION_TERMINAL` were removed from the policy file.

### Packaging

- `tsup.config.ts`: entry `subscription: 'src/subscription-core/index.ts'`.
- `package.json`: `exports["./subscription"]` (import/require with `types`), and new `typesVersions` `{ "*": { "paypal": ["./dist/paypal.d.ts"], "subscription": ["./dist/subscription.d.ts"] } }`. I included `paypal` too because the node10 smoke test type-checks root, `/paypal` and `/subscription` together (T4 can keep it as is).

### Tests added

- `src/subscription-core/lib/__tests__/subscription-money.unit.test.ts` (36): exponents, "10" vs "10.00", JPY, 3-decimal currencies, > MAX_SAFE_INTEGER exactness, rejects numbers/signs/exponent/sep/spaces/0.01 JPY.
- `.../normalize-paypal-subscription-event.unit.test.ts` (40): full field mapping, sale/refund mapping, 17 named rejection cases (numeric ids, missing resource, plan/checkout events, sale without billing agreement, oversized ids...), never-throws on hostile input (undefined, 200k-deep nesting, 5 MB body, `__proto__`, wrong-typed fields), unicode escapes (`-` decoded and accepted; NUL and RLO rejected), `deriveProviderEventId`, `isFreshTransmission` table.
- `.../reduce-subscription.vectors.unit.test.ts` (41): 35 named sequence vectors (normalise -> reduce, as a host would) covering issue #2 a/b/c with and without timestamps, issue #4 (UPDATED billing fields, plan mismatch with stored and expected plan, 0.01 JPY as currency and amount mismatch, lower/higher/numeric amounts, malformed expected price, PAYMENT.FAILED counter from resource and by increment, refund/reversal), equal and missing timestamps, invalid stored watermark, duplicates; each step checks input not mutated, noop returns the input state, determinism. Plus effect-payload tests and `subscription_mismatch`.
- `test/subscription-core-boundary.test.ts` (3): AST scan: runtime imports must stay inside `subscription-core`, `contracts` only type-only; no package/builtin imports (`fs`, `http`, `crypto`, ...), no dynamic import/require, no `Date.now`, `new Date()`, `Math.random`, `performance.now`, crypto randomness, `process.env`, timers, `fetch`; with scanner self-tests.
- `test/subscription-entry-consumer.test.ts` (5): built ESM/CJS files; scratch consumer under `node_modules/.cache/` linking the package by name: ESM `import`, CJS `require` (asserts no axios/zod/express/@idevconn/payment in `require.cache`), and `tsc` type-check under `moduleResolution` `node10` and `node16`. Verified the node10 case fails with TS2307 when `typesVersions` is removed.
- `test/dist-package-surface.test.ts`: subscription dist files exist and load (ESM + CJS).
- `src/core/lib/__tests__/subscription-transition-policy.unit.test.ts`: new case `approved|suspended -> approval_pending` throws, `unknown -> approval_pending` allowed.

README: entry-point row and a "Pure core" section (contract, rules, example).

## Rulings

- Ruling: `amountMinor` is a decimal string (like `CanonicalMoney`), not a JS number, so large amounts stay exact; comparisons use `BigInt`.
- Ruling: currency exponents follow ISO 4217 (HUF/TWD are 2, as ISO), not PayPal's "no decimals" list; parsing PayPal's "1000" HUF still works. The existing `core/lib/money.ts` table (USD/EUR/GBP/JPY only) was left unchanged to avoid changing plan-creation amounts in T1; T6/T7 may want to point it at `currencyMinorUnitExponent`.
- Ruling: a sale amount with more fraction digits than the currency allows (non-zero, e.g. "0.01" JPY) or a non-string amount gives `payment.amountMinor = null` (event still `ok`); the reducer then reports `amount_mismatch` and does not apply (fail closed), also when no price is expected (`expected: null` in the effect).
- Ruling: a malformed `expectedPayment` fails closed (`amount_mismatch`). A higher amount is accepted (tax/setup fee). Currency mismatch is reported alone (no amount comparison across currencies).
- Ruling: `expectedPlanId` defaults to the stored `state.providerPlanId` (needed for T6's "compare event plan with the stored one"); a host doing a plan revision passes the new plan as `expectedPlanId`.
- Ruling: added `providerSubscriptionId` to `SubscriptionState` (not in the plan list) so an event for another subscription is a `subscription_mismatch` noop when the state knows its id.
- Ruling: the late-CREATED rule was widened in the shared guard: `approved` and `suspended` (not only `active`) can no longer move to `approval_pending`. This changes `assertSubscriptionTransitionAllowed` / `resolveSubscriptionStatusTransition` for those two pairs (plan requirement; no existing test depended on the old behaviour).
- Ruling: `parseSubscriptionResourceStateTimestamp` now uses the strict core parser: ISO date or date-time with explicit zone (`Z`/offset); zone-less date-times and loose `Date.parse` inputs (e.g. "1") are null, so ordering never depends on the host time zone. An unparseable stored watermark now counts as absent ("newer") instead of "equal".
- Ruling: ordering is checked before the transition guard, so a late CREATED with an older timestamp reports `stale`, without timestamps `transition_rejected`. A blocked transition never advances the watermark.
- Ruling: `source: 'lookup'` skips ordering, never moves the watermark back (keeps the max), still obeys terminal/regression guards. A lookup or UPDATED with an unknown/missing status leaves the status as is and still applies billing fields.
- Ruling: payment events (`PAYMENT.SALE.*`, `PAYMENT.FAILED`) never change status or the `stateAt` watermark. `lastPayment` never moves back in time. Refund/reversal is `applied` with only the effect.
- Ruling: `decision: 'applied'` means "accepted, act on the effects and store the state" (may have no effects, e.g. a redelivered same state); `'noop'` returns the identical input object and may carry diagnostic effects (mismatches).
- Ruling: supported event types are a closed list (BILLING.SUBSCRIPTION.{CREATED,APPROVED,ACTIVATED,RE-ACTIVATED,UPDATED,SUSPENDED,CANCELLED,EXPIRED,PAYMENT.FAILED}, PAYMENT.SALE.{COMPLETED,REFUNDED,REVERSED}); anything else, including unknown future BILLING.SUBSCRIPTION.* types, is `unsupported_event_type`. Sales without `billing_agreement_id` are `missing_subscription_id` (not a subscription sale).
- Ruling: provider ids must be printable ASCII without spaces, 1-128 chars; numeric ids are rejected, `__proto__` and inherited keys are never read. No size cap in the normaliser (T3 owns the intake cap); 5 MB and 200k-deep inputs return without throwing.
- Ruling: refund `saleId` = `resource.sale_id ?? resource.id`; sale amount accepts `{total,currency}` and `{value,currency_code}`.

## Not done / notes for later tasks

- The engine (`WebhookProcessingService`, reconciliation, `resolveBillingAgreementId`) is not yet wired onto `reduceSubscription`/the normaliser; that is T6. `subscription-evidence-application.ts` needed no change (it uses the policy re-exports).
- `assertSubscriptionTransitionAllowed` still throws plain `Error` (T2).

## Files (`git status --short`)

```
 M README.md
 M package.json
 M src/core/lib/__tests__/subscription-transition-policy.unit.test.ts
 M src/core/lib/subscription-transition-policy.ts
 M test/dist-package-surface.test.ts
 M tsup.config.ts
?? src/subscription-core/
?? test/subscription-core-boundary.test.ts
?? test/subscription-entry-consumer.test.ts
```

`src/subscription-core/` contains: `index.ts`, `lib/subscription-core-types.ts`, `lib/subscription-money.ts`, `lib/subscription-status-rules.ts`, `lib/normalize-paypal-subscription-event.ts`, `lib/reduce-subscription.ts`, `lib/__tests__/subscription-money.unit.test.ts`, `lib/__tests__/normalize-paypal-subscription-event.unit.test.ts`, `lib/__tests__/reduce-subscription.vectors.unit.test.ts`.

## Fix wave (review APPROVED_WITH_FIXES, all ten findings)

Tests first: every new vector/test was run and seen failing before the fix (61 failing tests in the first run), then green.
Final: `npm run lint && npm run typecheck && npm run build && npm test` green, **83 files / 642 tests passed** (+1 file, +76 tests over the first hand-over). Reviewer probes `t1review/p1.mjs` now show every finding fixed.

1. (blocker) Plan check: a mismatch now blocks only a result of `approved`/`active`. Suspensions, cancellations, expiries (webhook or lookup) and `PAYMENT.FAILED` apply and still emit `plan_mismatch` (before `status_changed` / `payment_failed`). Default decided explicitly: `expectedPlanId ?? state.providerPlanId`; a mismatching plan is never stored, the host adopts a revised plan by passing it as `expectedPlanId`. Documented in the `ReduceSubscriptionOptions.expectedPlanId` doc comment, the `reduceSubscription` doc comment and the README. Vectors: revise then CANCELLED, revise then SUSPENDED, lookup CANCELLED on the new plan, PAYMENT.FAILED on the new plan, UPDATED staying active on another plan (noop), lookup adopting the plan via `expectedPlanId`.
2. Dedupe: README now says hosts MUST dedupe on `providerEventId` (and on `saleId` for completed sales) before the reducer, and the example shows it (unique inserts in the save transaction; sale id only for `PAYMENT.SALE.COMPLETED` so a refund of a recorded sale is not dropped). Reducer safety net: new state fields `recentEventIds` and `recentSaleIds` (bounded, `SUBSCRIPTION_RECENT_ID_LIMIT = 16`, exported); a repeat is a `duplicate_event` noop. Vectors: SALE.COMPLETED, UPDATED, same SALE.COMPLETED; the same sale under a new webhook id; PAYMENT.FAILED, UPDATED, same PAYMENT.FAILED; bound test (20 events keep 16); a stored row without the lists still works.
3. One currency table: `currencyFractionDigits` in `src/core/lib/money.ts` now returns `currencyMinorUnitExponent(currency.trim())`; the local 4-currency table is gone. Tests: USD 2, JPY 0, KRW 0, BHD 3, KWD 3, trimmed lowercase, unknown 2, equality with the core, KRW/BHD conversions both directions. All existing callers (`paypal-marketplace-executor`, `payout-webhook-correlation`) pass their tests.
4. `active|suspended -> approved` is now refused by `isSubscriptionStatusTransitionAllowed` (so also by the engine's `assertSubscriptionTransitionAllowed` / `resolveSubscriptionStatusTransition`). Vectors for both.
5. `providerSubscriptionId` is learned from the first applied event (`state.providerSubscriptionId ?? event.providerSubscriptionId`, also from a sale); later events for another id are `subscription_mismatch` noops. Vectors.
6. `parseProviderTimestamp` validates month, day-of-month (leap years), hour <= 23, minute/second <= 59 and offset parts before parsing; Feb 30, Feb 29 in a non-leap year, Apr 31, 24:00, :60 and +24:00 are null. New `subscription-status-rules.unit.test.ts`.
7. `compareProviderStateTimestamps` runs both values through `parseProviderTimestamp` (garbage incoming is `older`, or `equal` when both are unusable; garbage stored counts as absent), and `evaluateSubscriptionStateOrdering` treats an unparseable incoming time as missing and stores the normalised ISO value. Tests.
8. `failedPaymentsCount` never decreases: PAYMENT.FAILED takes `max(stored, incoming)` or `stored + 1`; subscription resources take `max`, except a provider reset is accepted as is on `ACTIVATED`/`RE-ACTIVATED` or when the resource's last payment is newer than the stored one. Documented in the type, the reducer comment and the README. Vectors for all four cases.
9. The returned state is always a fresh copy (`cloneState`: new `lastPayment` object and id lists), also for a noop (an equal copy, no longer the same object; the vector runner now asserts `not.toBe` on every step), and `payment_failed.outstandingBalance` is copied. Test checks no shared references with the event or the input state.
10. Refund/reversal totals accept one leading `-` and keep the sign (`"-10.00"` -> `"-1000"`, `"-0.00"` -> `"0"`) via new exported `parseSignedDecimalToMinorUnits`; a negative `PAYMENT.SALE.COMPLETED` total stays unreadable (`null`, fails closed). Tests in money, normaliser and reducer.

Additional rulings from the fix wave:

- Ruling: the coordinator's instruction for 10 (keep the sign) was followed over the review's suggestion (report the absolute value).
- Ruling: only applied events are remembered in `recentEventIds`; a mismatch noop (amount/currency/plan on an access move) keeps returning its diagnostic effect on redelivery, documented in the README. Refunds are deduped by webhook id only (their `saleId` is the original sale's id, so it is not added to `recentSaleIds`).
- Ruling: `recentEventIds`/`recentSaleIds` are required fields of `SubscriptionState` (hosts persist them); the reducer tolerates them being absent on older rows.
- Ruling: the `noop` contract changed from "returns the same object" to "returns an equal copy" (finding 9 asks for no shared references with the input state).

## Files (`git status --short`, final)

```
 M README.md
 M package.json
 M src/core/lib/__tests__/money.unit.test.ts
 M src/core/lib/__tests__/subscription-transition-policy.unit.test.ts
 M src/core/lib/money.ts
 M src/core/lib/subscription-transition-policy.ts
 M test/dist-package-surface.test.ts
 M tsup.config.ts
?? src/subscription-core/
?? test/subscription-core-boundary.test.ts
?? test/subscription-entry-consumer.test.ts
```

`src/subscription-core/` adds `lib/__tests__/subscription-status-rules.unit.test.ts` to the files listed earlier.

## Proposed commit message (replaces the earlier one)

```
feat(subscription): add pure subscription core entry

Add @idevconn/payment-providers/subscription: an IO-free PayPal
subscription event normaliser (decimal amounts to integer minor units
without floats, signed refund totals, strict ISO timestamps, never
throws) and a subscription state reducer with plain-data effects
(status, payments, plan/amount/currency mismatches). A plan mismatch
blocks only moves to approved/active, so a revised plan can still be
suspended or cancelled; recent event and sale ids give a bounded
redelivery safety net (hosts must still dedupe); the failed-payment
counter never goes back; returned state shares no references.

The engine's transition policy and currencyFractionDigits now use the
core's status rules and ISO 4217 table, so late CREATED/APPROVED events
no longer move a subscription back. Adds the tsup entry, exports and
typesVersions, table-driven vectors for issues #2 and #4, a purity
boundary test and ESM/CJS/node10 consumer smoke tests.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
```
