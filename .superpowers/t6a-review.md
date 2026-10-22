# T6a review: engine on the pure core (#4), T5 bugs 1+2, payload hash on resume

Verdict: **APPROVED_WITH_FIXES**

Gate observed: `npm run lint` clean, `npm run typecheck` clean, `npm run build` ok, `npm test` 104 files / 987 tests passed.

T5 probes against the current build (`scratchpad/t5review/tools/`):
- `p-sale.mjs`: `providerSubscriptionId I-1 providerReferenceId I-1`, both lookups of `I-1` find the operation.
- `p-cancel.mjs`: `applied 1`, command `succeeded`, subscription `cancelled`, `findByReference(I-1) -> subscription`.

Regressions: `diff -rq` against `snap-after-t5`: only 3 new test files and 2 edited test files. No `it(`/`expect(` line was removed (diff of both edited test files and the kit shows additions only). Runtime exports: nothing removed from `index`, `paypal`, `subscription`, `testing`, `legacy` (pre-T6a snapshot built in a scratch copy, `dist` compared).

Probe scripts: `/tmp/claude-1000/-home-vladimir-tkach-Projects-crawler-nx/7d726264-0747-4d01-8456-c621fc623f57/scratchpad/t6areview/` (`p-revise.mjs`, `p-jsonb.mjs`, `p-cap.mjs`, `p-cap2.mjs`).

## Findings

1. **important** (spec A: single source of truth). The lifecycle command path still runs its own rules, outside the reducer. `subscription-lifecycle-service.ts:953-971` refreshes the subscription after a successful cancel/suspend/activate with `assertSubscriptionProviderPlanSnapshotConsistent` (`subscription-provider-plan-consistency.ts:7-21`) and `applySubscriptionDomainUpdate` (`subscription-evidence-application.ts:789-820`, which uses `resolveSubscriptionStatusTransition` and `persistDomainAwareOperationUpdate`). Effects:
   - A cancellation whose snapshot carries another plan is NOT applied. This contradicts the reducer rule and README:528 ("Cancellations and suspensions on another plan still apply").
   - The watermark is written unconditionally from the snapshot (`persistDomainAwareOperationUpdate`, lines 92-99), with no "never move back" rule.
   - `lastPayment` / `failedPaymentsCount` from the snapshot are dropped, and no effects reach the hook (no `status_changed` for a host-initiated cancel; the later CANCELLED webhook is a noop).

   Smallest fix: apply the command's provider result through `applySubscriptionEvents` with one `subscriptionEventFromProviderSnapshot(...)` step and `source: 'lookup'`, and keep `SUBSCRIPTION_PLAN_MISMATCH` only for `planMismatch`. Then `applySubscriptionDomainUpdate` and `assertSubscriptionProviderPlanSnapshotConsistent` can be deprecated like the other helpers.

2. **important** (B1: plan change). No engine-level way to adopt a new plan, and a revision loops forever. Probe `p-revise.mjs` (active on P-1, PayPal revise → `BILLING.SUBSCRIPTION.UPDATED` with P-2, no lookup):
   - The evidence stays `pending`, and each `recover()` run reprocesses it (`skipped:1` x3).
   - The hook got `plan_mismatch` 4 times in 3 runs.
   - `nextBillingTime` from UPDATED is never stored.
   - The cheaper renewal sale (5.00 vs stored plan price 10.00) is `amount_mismatch` and `lastPayment` stays null.

   The pure-core doc (README:91-94) says "pass the new plan as `expectedPlanId`", but the engine never passes `expectedPlanId` (`webhook-processing-service.ts:1005-1056`, `reconciliation-service.ts:757-780`), and the engine README section (README:528, 530) does not say what a host does. README:530 "once per processed evidence row" is also wrong for plan-mismatch rows (re-delivered on every reprocess).

   Smallest fix:
   - Document the adoption step for engine hosts: `updateOperation({ providerPlanId: <new>, amountMinor/currencyCode or null })` on the subscription operation, then `reprocessStoredWebhookEvidence(evidenceId)`. Or add a small `adoptSubscriptionPlan` helper that does the same.
   - Fix the README:530 wording.
   - T6b's attempt cap must also bound these rows.

   (A first ACTIVATED with a different plan form is not a risk: both create paths store the exact string sent to PayPal, `subscription-lifecycle-service.ts:479,497`.)

3. **important** (spec A: store contract and kit). `subscriptionStateJson` and `jsonb` contradict each other.
   - README:407 and the JSDoc at `contracts/lib/operations.ts:77-83` say "one nullable `text` or `jsonb` column ... verbatim". But the kit (`run-store-conformance.ts:697-734`) asserts the exact string with `toBe`. Postgres `jsonb` re-serialises it (spaces, key order), so a conforming jsonb store fails the kit.
   - Worse, `pg` / supabase-js return `jsonb` as an object. `parseStoredSubscriptionState` (`subscription-evidence-application.ts:266-274`) then does `JSON.parse(object)`, which throws and is swallowed as "no state". The state is lost on every write without any signal. Probe `p-jsonb.mjs`, after two `PAYMENT.FAILED` and one sale:
     - object-returning store: `failedPaymentsCount null lastPayment null`;
     - reformatted text: `2` / recorded (the engine itself copes with reformatted text).

   Smallest fix: either say `text` only (no jsonb) in README and JSDoc, or accept an object in `parseStoredSubscriptionState` (`isRecord(json) ? json : JSON.parse`) and make the kit compare `JSON.parse` results (deep equal) instead of strings.

4. **minor** (B2: effects lost). Held effects are silently dropped past 16 batches. `MAX_PENDING_EFFECT_BATCHES = 16` (`subscription-evidence-application.ts:181, 523-529`) evicts the oldest held batch. A later reprocess of that evidence reduces to a noop (the event id has also left the 16-id window, so the reducer cannot re-derive it), `deliverSubscriptionEffects` returns `delivered: true` for zero effects (`:682`), and the row is marked `processed` (`webhook-processing-service.ts:1082-1090`).

   Probe `p-cap2.mjs`: ACTIVATED with the hook down, then 16 sales with the hook down, then the hook up and ACTIVATED redelivered → `processed`, hook calls `[]`. The `status_changed` (access grant) is never delivered. The same silent "processed without delivery" happens on `redeliverHeldSubscriptionEffects` (`:1097-1129`) when the webhook service has no hook but reconciliation had one: the held entry also stays behind.

   Smallest fix: do not evict (entries are removed on success), or, when a `SUBSCRIPTION_EFFECTS_HOOK_FAILED` row finds no held effects and reduces to a noop, keep it `pending` with a distinct code instead of `processed`. `p-cap.mjs` (sales only) is safe, because evicted sales are recomputed.

5. **minor** (B3: amount rule). The expected price is "lowest positive cycle price or setup fee" (`subscription-lifecycle-service.ts:69-91`). It never gives a false positive for setup fee + first cycle, tax or quantity, because the check is "lower than". But:
   - A priced trial or a setup fee below the regular price disables the underpayment check for regular renewals (trial 1.00 + regular 10.00 → a 1.00 renewal passes).
   - After the host lowers the price (PayPal `update-pricing-schemes`, or revise to a cheaper plan, see finding 2), every renewal is `amount_mismatch` and `lastPayment` is never recorded again.

   Smallest fix: document both limits in README:529 and say that the host keeps the price current by setting the subscription's own `amountMinor`/`currencyCode`. Optionally store the REGULAR cycle price and compare against it once `cycles_completed` passes the trial cycles (T7 or later).

6. **minor** (B4: schema evolution). The `version` in `subscriptionStateJson` is written but never read (`subscription-evidence-application.ts:266-287`). After a rollback, a row written by a newer format is read as v1, and the next write drops its unknown fields. Fix: when `version > 1`, keep the unknown fields on rewrite, or fail closed (leave the evidence pending).

7. **minor** (B5: payload hash). `handleExistingEvidence` (`webhook-processing-service.ts:393-395`) hashes the exact UTF-8 string, so a proxy that changes bytes (CRLF, re-encoding) gets `INVALID_REQUEST` on every redelivery. The error code is the same as the intake errors, so hosts cannot tell the two apart. A row stored unverified (earlier `VERIFICATION_UNAVAILABLE`) can only be verified by a redelivery (`payment-recovery-service.ts:138-139` skips it), so the event is then stuck for good. PayPal redeliveries are byte-identical, so the risk is low. Fix: README sentence (with carry-over T7 (f)): the raw body must reach `receiveWebhook` byte-for-byte on every delivery; `WebhookEventPayloadMismatchError` means a changed body (answer non-2xx, investigate the proxy).

8. **minor** (B7: export surface). The root gains 11 runtime exports. These are engine internals that freeze the `subscriptionStateJson` layout and the hold/clear protocol into semver: `applySubscriptionEvents`, `clearPendingSubscriptionEffects`, `deliverSubscriptionEffects`, `readHeldSubscriptionEffects`, `resolveExpectedSubscriptionPayment`, `normalizeSubscriptionEvidencePayload`, `subscriptionEventFromProviderSnapshot`. The ones hosts need: `readSubscriptionOperationState`, `SUBSCRIPTION_EFFECTS_HOOK_FAILED`, `SUBSCRIPTION_COMMAND_NOT_APPLIED`, `WebhookEventPayloadMismatchError` and the hook types. Fix (T7): an explicit export list in `src/core/index.ts` for this module.
