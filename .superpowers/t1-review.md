# T1 review: pure subscription core

Verdict: APPROVED_WITH_FIXES (fix 1 and 2 before T6 wires the engine onto the reducer; the rest can ride along).

Checks observed (reviewer run, working tree as handed over): `npm run lint` green, `npm run typecheck` green,
`npm run build` green (emits `dist/subscription.{js,cjs,d.ts,d.cts}`), `npm test` 82 files / 566 tests passed.

Spec compliance (A): every T1 item is present (tsup entry, `exports["./subscription"]`, `typesVersions`, normaliser
fields, `deriveProviderEventId`, `isFreshTransmission`, reducer rules and effects, vectors for #2/#4/review focus,
AST purity boundary test, ESM/CJS/node10 smoke, README "Pure core"). Policy refactor keeps the engine call sites
working; no regression found in the engine paths (`reconciliation-service.ts:264,440,769`,
`subscription-evidence-application.ts:73,179,309`, `webhook-processing-service.ts:730`). Gaps are folded into the
findings below (missing vectors in 1 and 2).

Probes: `/tmp/claude-1000/-home-vladimir-tkach-Projects-crawler-nx/7d726264-0747-4d01-8456-c621fc623f57/scratchpad/t1review/p1.mjs`, `p2.mjs` (run against `dist/subscription.js`).

## Findings

1. **blocker** - plan check blocks cancellations and lookups after a plan change.
   `src/subscription-core/lib/reduce-subscription.ts:235-240` (default `expectedPlanId ?? state.providerPlanId`,
   checked before every event kind). Probe, stored `{status:'active', providerPlanId:'P-1'}`, no `expectedPlanId`:
   `CANCELLED` with `plan_id:'P-2'` -> `noop plan_mismatch, status active`; `SUSPENDED` same; a `lookup` returning
   `CANCELLED`/`P-2` -> `noop plan_mismatch, status active`; `PAYMENT.FAILED` with `P-2` -> `noop plan_mismatch`.
   After a PayPal revise (or any plan drift) the subscription can never be cancelled/suspended through the core, and
   reconciliation cannot repair it, so the failure direction is "keeps access". Smallest fix: run the plan check only
   when the resolved status is `approved`/`active` (or for activation-type events); for moves to
   `suspended|cancelled|expired` and for `PAYMENT.FAILED`, apply and still emit the `plan_mismatch` effect. Also
   decide the stored-plan default explicitly (T6 needs it, but a lookup should be able to adopt a new plan when the
   host passes it); add vectors "revise to P-2 then CANCELLED", "lookup CANCELLED with P-2".

2. **important** - redelivery dedupe only catches the immediately previous event; payment effects fire twice.
   `reduce-subscription.ts:228` compares only `lastEventId`. Probe: `SALE.COMPLETED(WH-PAY)`, `UPDATED(WH-UPD)`,
   `SALE.COMPLETED(WH-PAY)` again -> second call `applied` with `payment_completed` again; `PAYMENT.FAILED(WH-F)`,
   `UPDATED`, `PAYMENT.FAILED(WH-F)` -> counter 1 then 2. PayPal retries deliveries for days, and SALE.COMPLETED +
   UPDATED routinely arrive together, so interleaved redelivery is normal; hosts are told to treat
   `payment_completed` as a business hook (credits). README.md:92-93 says hosts "should still dedupe", but the README
   example (README.md:102-111) does not, and does not say that `lastEventId` only catches back-to-back repeats.
   Smallest fix: README states the dedupe on `providerEventId` (and `saleId` for payments) is REQUIRED before
   `reduceSubscription` and the example shows it; add a vector documenting the interleaved case.

3. **important** - two public currency exponent tables disagree. `src/subscription-core/lib/subscription-money.ts:6-31`
   (KRW 0, BHD/KWD/... 3) vs `src/core/lib/money.ts:7-12` (`currencyFractionDigits`, exported from the root, KRW 2,
   BHD 2). Probe: core `KRW` 0 / `BHD` 3, root `currencyFractionDigits` still exported. A host that builds
   `expectedPayment` with the root helper gets a false `amount_mismatch` for KRW and, for BHD, an expected price 10x
   too small, so an underpayment of 1.000 BHD against a 10.000 BHD plan passes. The report defers this to T6/T7;
   record it as a T6 must-do (point `currencyFractionDigits` at `currencyMinorUnitExponent`) rather than optional.

4. **minor** - late `APPROVED` regresses `active`/`suspended` when timestamps are missing.
   `subscription-status-rules.ts:12,145` only blocks `approval_pending`. Probe: state `active` (no watermark),
   `BILLING.SUBSCRIPTION.APPROVED` without `update_time` -> `approved`; from `suspended` -> `approved`. PayPal's
   lifecycle never goes ACTIVE/SUSPENDED -> APPROVED (APPROVED is only between APPROVAL_PENDING and ACTIVE), so the
   same guard should block it. Fix: also refuse `next === 'approved'` from `active|suspended`; one vector. The widened
   `approved|suspended -> approval_pending` block itself is correct for PayPal.

5. **minor** - `providerSubscriptionId` is never learned from events. `reduce-subscription.ts:186-196` copies it only
   from the input state. Probe: `initialSubscriptionState()` + ACTIVATED for `I-1` -> `providerSubscriptionId: null`;
   then CANCELLED for `I-OTHER` -> applied, `cancelled`. The `subscription_mismatch` guard is inert for any host that
   follows the README example (`?? initialSubscriptionState()`). Fix:
   `providerSubscriptionId: state.providerSubscriptionId ?? event.providerSubscriptionId` in the subscription and sale
   branches.

6. **minor** - `parseProviderTimestamp` accepts impossible dates and rolls them over.
   `subscription-status-rules.ts:30-34`. Probe: `2026-02-30T00:00:00Z` -> `2026-03-02T00:00:00.000Z`,
   `2026-10-22T24:00:00Z` -> next day. A wrong timestamp becomes a valid watermark. Fix: after `Date.parse`, check the
   input's date (and hour <= 23) against the UTC parts of the zone-adjusted result, or validate day-of-month
   before parsing. Real PayPal forms (`...Z`, `....000Z`, offsets) all parse, so no false rejection seen.

7. **minor** - exported ordering helpers return `equal`/`apply` for an unparseable incoming time.
   `subscription-status-rules.ts:46-53`. Probe: `compareProviderStateTimestamps(validIso, 'garbage')` -> `equal`;
   `evaluateSubscriptionStateOrdering({... incomingStateAt:'garbage'})` -> `{action:'apply', stateAt:'garbage'}` (the
   garbage then becomes the watermark). The reducer is safe (it only passes parsed values), but these are public now.
   Fix: treat an unparseable incoming like a missing one (run it through `parseProviderTimestamp`).

8. **minor** - `failedPaymentsCount` can move backwards. `reduce-subscription.ts:135`. Probe: stored 3, an
   out-of-order PAYMENT.FAILED with `failed_payments_count: 1` -> 1. Fix: `Math.max` with the stored value (PayPal's
   counter resets on a successful payment, which arrives as UPDATED/lookup and still sets it through line 194).

9. **minor** - returned state aliases event objects. `reduce-subscription.ts:181-184` (`lastPayment`) and 142
   (`outstandingBalance` in the effect). Probe: `result.state.lastPayment === event.lastPayment` -> `true`; nothing is
   frozen. Inputs are not mutated, but a host that mutates the returned state mutates the event. Fix: copy
   (`{ ...event.lastPayment }`) or document as read-only.

10. **minor** - negative sale totals read as unreadable. `subscription-money.ts:35`, `normalize-...ts:166-168`. Probe:
    `PAYMENT.SALE.*` with `total:"-10.00"` -> `amountMinor: null`. Harmless for COMPLETED (fails closed), but if PayPal
    sends signed totals on REVERSED/REFUNDED (unverified offline) the `refund_or_reversal` effect loses the amount.
    Fix: for refund/reversal events accept a leading `-` and report the absolute value.
