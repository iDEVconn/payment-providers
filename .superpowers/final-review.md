# Final whole-branch review: `feature/pure-core-and-fixes` (0.2.1 -> 0.3.0)

Reviewer run date: 2026-10-22. Tree: uncommitted working tree on top of `c63df85` (0.2.1 + `.gitignore`).
Scratch: `/tmp/claude-1000/-home-vladimir-tkach-Projects-crawler-nx/7d726264-0747-4d01-8456-c621fc623f57/scratchpad/finalreview/`
(`e2e.mjs`, `ddl-probes.mjs`, `probes2.mjs`, `export-diff.mjs`, `mutate.mjs`, `mutate-build.mjs`, `readme-sql-claim.unit.test.ts`,
`gate1.log`, `gate-flakes.log`, `mutations*.log`). Nothing in the repo was edited by this review except this file.

## Verdict: READY_WITH_FIXES

No blocker. The 19 `Fixes #n` claims hold (18 fully, #7 with one documented gap that the factories cover). The code is in
good shape; the findings are in the README's Postgres example (it does not pass the package's own conformance kit), two
SQL-store sharp edges around `consumerDeliveryStatus`, one pre-existing ordering rule that drops a same-second status
change, and doc/quality items.

## 1. Gate

| Check | Result |
|---|---|
| `npm run lint` | exit 0 |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 (ESM + CJS + d.ts/d.cts, 5 entries) |
| `npm test` x4 | 111 files / 1090 tests passed, 4 of 4 runs (no flake) |
| `npm audit` | 0 vulnerabilities |
| `npm pack --dry-run` | 67 files, 720.5 kB packed / 4.1 MB unpacked: `dist/*`, `README.md`, `LICENSE`, `package.json` only; no `.superpowers`, no `src`, no tests; `index|paypal|subscription|legacy|testing` each as `.js`, `.cjs`, `.d.ts`, `.d.cts` |

## 2. Fix claims (PR body `Fixes #n`)

Re-run against the new `dist/` with the original probes (adapted copies in `scratchpad/t6b-probe`, `t3review`, `t5review/tools`,
`t6areview`), plus the E2E host (`e2e.mjs`) and mutation testing (section 3).

| Issue | Verdict | Evidence (observed) |
|---|---|---|
| #4 billing data / payment events / plan+amount checks | VERIFIED | E2E: `lastPayment {999 USD, 10:01:30}` and `failedPaymentsCount 2` read back via `readSubscriptionOperationState`; sale 1.00 USD -> `amount_mismatch`, 999 JPY -> `currency_mismatch`, body `plan_id` mismatch -> `SUBSCRIPTION_PLAN_MISMATCH` without lookup (p3/p-revise); `UPDATED` processed. Pins: `subscription-core-wiring` (11), `reduce-subscription.vectors`, `subscription-state-fix-wave`. Mutations #4a-#4d killed |
| #6 store split + conformance kit | VERIFIED | `SubscriptionStore` = 5 interfaces; `subscription-store-only.unit.test.ts` runs the 4 services on a 20-method store; `/testing` exports `runStoreConformance` (40 cases, memory store passes). Mutation #6 killed |
| #7 production boot guards | VERIFIED (one gap, see F7) | p5/prod probes: prod + no creds -> throws; prod + unconfigured status -> throws; verifier without `webhookId` in prod -> throws at build; kill switch builds a pending-storing verifier. Mutations #7a/#7b/#7c killed |
| #8 reconciliation starvation | VERIFIED | p5: `foreign=30`: `noOps=30,0,0`, S7 `active` after the first `reconcile(25)`. Mutations #8a/#8b/#8c killed |
| #9 CJS identity + node10 types | VERIFIED | `export-diff.mjs`: `index.cjs` and `paypal.cjs` share one chunk; `dist-entry-identity.test.ts` + `entries-consumer.test.ts` (node10 and node16 via real `tsc`) pass. Build mutation #9 (see `mutations-build.log`) |
| #10 dependency footprint | VERIFIED | `@idevconn/payment` optional peer; root/paypal/subscription/testing load no axios/zod/express/@idevconn/payment (`dist-entry-identity.test.ts` 75-104); `/legacy` entry exists. Build mutation #10 |
| #11 workflows | VERIFIED | `permissions: {}` at workflow level, job-scoped; `npm ci --ignore-scripts` everywhere; all `uses:` SHA-pinned and re-verified by me via `gh api` under bash: checkout `11d5960a` = `v4.4.0`, setup-node `49933ea5` = `v4.4.0`, changesets `a45c4d59` = commit behind annotated tag `v1.9.0`; vitest 4.1.12, audit 0 |
| #12 create/plan validation, stale submitted | VERIFIED | p3: REGULAR without price -> INVALID_REQUEST, TRIAL after REGULAR -> INVALID_REQUEST; plan status checked on `planOperationId` path (`subscription-lifecycle-create-options` 91-109); stale `submitted` listed with `submittedStaleBefore` and marked `unknown` by reconcile (`stale-submitted-operations`). Mutations #12a/#12b killed |
| #13 create fields | VERIFIED | E2E: PayPal body carried `application_context.shipping_preference: NO_SHIPPING` and `subscriber.email_address`; validation in `subscription-create-options.ts`. Mutation #13 killed |
| #14 diagnostics, typed errors, sha256 util, path ids | VERIFIED | `providerDebugId` on errors and `failureMessage` (`subscription-lifecycle-create-options` 214-251); `assertSubscriptionTransitionAllowed` throws `PaymentReliabilityError`; `sha256Payload` in `src/core/lib/sha256-payload.ts`; `pathSegment` on every id (`paypal-path-encoding` 9 cases). Mutations #14a/#14b killed |
| #15 intake | VERIFIED | `splice.mjs`: raw body spliced byte-identical, injection attempts rejected; `fresh.mjs`/`webhook-intake-guards` (16): headers, 256 KiB cap in UTF-8 bytes, event id derived from the body, mismatch rejected, freshness opt-in. Mutations #15a-#15d killed |
| #16 OAuth | VERIFIED | p8: revoked token -> 2 OAuth fetches, 3 of 3 webhooks processed; 10 concurrent 401s -> one refresh; executor double 401 -> `PROVIDER_AUTH_FAILURE` with the same `PayPal-Request-Id`; cache key includes `clientId`; `live-paypal-http-clients` tests (13). Mutations #16a/#16b/#16c killed |
| #19 verify 401/403/400 | VERIFIED | p1: s503/html502/timeout/s401/s403/s400/200-without-status all `pending/pending err=VERIFICATION_UNAVAILABLE`, redelivery processed; only `FAILURE` rejects. Mutation #19 killed |
| #20 recovery starvation | VERIFIED | p5: 30 verification-unavailable rows + 1 verified/pending: first `recover(25)` = `claimed 1, processed 1`, S9 cancelled. Mutations #20b/#20c killed |
| #21 `consumer: null` | VERIFIED | p5: `recover` with `consumer: null` -> `{claimed:0, delivered:0}` x3. Mutation #21 killed |
| #22 overlapping create retry | VERIFIED | p6: retry concurrent with the in-flight original -> `stored submitted I-1`, 2 POSTs, 1 request id, 1 PayPal subscription; p6b after lease expiry no extra POST. Mutations #22a-#22d killed |
| #23 claim reason string | VERIFIED | p6 "store whose claim writes a different transition reason": retry makes the POST (`submitted I-1`); `claim-transition-kind` (5) incl. a grep test that no core module reads `reason`. Mutation #23 killed |
| #24 consumer delivery cap / narrowed event | VERIFIED | `payment-recovery-consumer-delivery` (11): cap 10 -> `failed_terminal`, narrowed event, `includeRawPayload`; E2E: 13 events delivered once each. Mutations #24a/#24b/#24c killed |
| #25 email in fingerprint | VERIFIED | p6: retry with another email -> `IDEMPOTENCY_CONFLICT`, no POST; E2E same for `createSubscription`. Mutation #25 killed |

T5 engine findings carried into T6: `p-sale.mjs` (`findBySubscriptionId(I-1)` still finds the op after a sale reconcile) and
`p-cancel.mjs` (uncertain cancel command reconciles to `succeeded`, subscription `cancelled`) both pass.

## 3. Mutation testing

Scratch copy `finalreview/mut/repo` (node_modules symlinked), one revert at a time, `npx vitest run src` (98 files / 1020 tests
baseline, 4.2 s). Results `mutations2.log` (corrected counts) and `mutations-build.log` (#9/#10 with a rebuild):

| Mutation (fix reverted) | Result | Failing tests / files |
|---|---|---|
| #7a `resolvePaymentRuntime` never refuses reject-only in prod | KILLED | 6 failed: `resolve-payment-runtime` |
| #7b factories never refuse a blocked client in prod | KILLED | 18 failed: `paypal-factory-production-guard`, `paypal-checkout-executor.factory` |
| #7c verifier does not require `webhookId` at build | KILLED | 2 failed: `paypal-factory-production-guard` |
| #8a/#20a lists ignore `nextAttemptAt` (`isRetryDue`) | KILLED | 14 failed: `fair-retry-queue`, `fair-retry-fix-wave`, kit (memory + broken-stores) |
| #8b never `gave_up` | KILLED | 4 failed in `fair-retry-queue` (gives up / uncertain op / plan-mismatch rows); note: the full-suite run printed no totals because `fair-retry-fix-wave` "default schedule outlasts PayPal redelivery" loops until `gave_up` and never ends under this mutation (test should bound the loop) |
| #8c reconcile: unmatched rows consume the budget | KILLED | 2 failed: `fair-retry-queue`, `fair-retry-fix-wave` |
| #20b recovery claims verification-pending rows | KILLED | 2 failed: `fair-retry-queue`, `payment-recovery-service` |
| #20c recovery never defers a row | KILLED | 4 failed: `fair-retry-queue`, `fair-retry-fix-wave` |
| #21 claims delivery-only rows without a consumer | KILLED | 1 failed: `payment-recovery-consumer-delivery` |
| #19 verify 4xx terminal again | KILLED | 7 failed: `paypal-webhook-verification-recovery`, `live-paypal-webhook-verification-client` |
| #15a re-serialised body sent to verify | KILLED | 1 failed: `live-paypal-webhook-verification-client` |
| #15b no body cap / #15c id mismatch unchecked / #15d missing headers accepted | KILLED | 2 / 2 / 1 failed: `webhook-intake-guards` |
| #16a rejected token not evicted / #16b cache key without clientId / #16c no 401 resend | KILLED | 17 / 2 / 17 failed: `paypal-oauth-token-retry`, `paypal-webhook-verification-recovery`, `token-cache-scope`, `live-...-verification-client` |
| #13 no `NO_SHIPPING` default | KILLED | 4 failed: `paypal-subscription-executor` |
| #14a `pathSegment` accepts empty/`.`/`..` / #14b does not encode | KILLED | 42 / 7 failed: `paypal-path-encoding` |
| #12a REGULAR without price / #12b stale submitted never listed | KILLED | 1 / 2 failed: `subscription-billing-cycles`, `stale-submitted-operations` |
| #22a result loses to a conflicting write / #22b failure overwrites / #22c overlap 4xx = failed / #22d claim loser throws | KILLED | 4 / 2 / 2 / 1 failed: `subscription-create-overlap` |
| #4a amount check / #4b plan mismatch / #4c `subscriptionStateJson` not persisted / #4d PAYMENT.FAILED not counted | KILLED | 3 / 17 / 15 / 8 failed: `reduce-subscription.vectors`, `subscription-core-wiring`, `subscription-state-fix-wave`, `reconciliation-subscription-core`, ... |
| #4e4 normaliser: a sale takes `resource.id` as the subscription id (the T5 sale-id overwrite) | KILLED | 19 failed: `normalize-paypal-subscription-event`, `subscription-core-wiring`, `reconciliation-subscription-core`, ... |
| #23 claim detection by reason text | KILLED | 6 failed: `claim-transition-kind` |
| #24a no delivery cap / #24b never `failed_terminal` / #24c whole row to the consumer | KILLED | 1 / 1 / 2 failed: `payment-recovery-consumer-delivery` |
| #25 email not in fingerprint | KILLED | 3 failed: `subscription-create-fingerprint` |
| #6 every store counts as having every capability | KILLED | 4 failed: `subscription-store-only` |
| #9 tsup `splitting: false` (rebuild) | KILLED | 2 failed: `dist-entry-identity` |
| #10 root re-exports `LegacyPaymentError` from `@idevconn/payment` (rebuild) | KILLED | 6 failed: `dist-declarations`, `dist-entry-identity`, `dist-export-surface` |
| #4e reconciliation looks up the subscription by `evidence.resourceId` (sale id) | SURVIVED | 1020 passed: the lookup fake ignores its argument (F13, test gap); #4e2/#4e3 (apply/reducer id overwrite) also survived but are equivalent mutants: the reducer's `subscription_mismatch` guard and the normaliser's `billing_agreement_id` make them no-ops |

All eight critical groups the task named (#7 guards, #8/#20 fair queue, #13..#16/#19 verifier+OAuth, #22 overlap, #4 persistence,
#23 typed claims, #24 consumer cap) fail without their fix.

## 4. End-to-end host (`e2e.mjs`, public dist entries only)

Minimal host: `MemoryPaymentReliabilityStore`, `resolvePaymentRuntime(nodeEnv: 'production')`, `buildPaypalSubscriptionExecutor`,
`buildPaypalWebhookVerifier({ webhookId })`, the four services, a stubbed `fetch` emulating PayPal (OAuth, catalog, plan,
subscription create keyed by `PayPal-Request-Id`, GET, verify-webhook-signature with modes). Output: `E2E OK`.

Sequence and result: product -> plan (REGULAR 9.99 USD) -> create (`submitted/approval_pending`, approval URL, `NO_SHIPPING`,
email) -> replay same key (no POST) -> other email (`IDEMPOTENCY_CONFLICT`, no POST) -> ACTIVATED (1 `status_changed`,
1 `period_updated`) -> SALE 9.99 (`payment_completed`, `lastPayment` stored) -> exact duplicate (processed, no effect) -> same
`saleId` under a new webhook id (not paid twice) -> late CREATED/APPROVED (stale, no effect) -> sale 1.00 / 999 JPY (mismatch
effects, last payment unchanged) -> PAYMENT.FAILED (count 1) -> SUSPENDED with the hook throwing once (state persisted, row
`pending`, `recover()` delivers the held effect exactly once, second run delivers nothing) -> CANCELLED with verify 503 then
HTML 502 (both `VERIFICATION_UNAVAILABLE`, row pending, recovery claims 0) then SUCCESS (cancelled, one effect) -> tampered
redelivery (`WEBHOOK_PAYLOAD_MISMATCH`) -> late ACTIVATED (terminal, ignored) -> forged signature (`VERIFICATION_REJECTED`) ->
REFUNDED with a 401 on the cached token (one refresh, processed, `refund_or_reversal`) -> PAYMENT.FAILED with a crash after the
hook and before "processed" (recovery reprocesses, no second delivery) -> 3 recovery runs: 13 consumer deliveries, no duplicate.
Final: `cancelled`, `nextBillingTime 2026-11-22`, `stateAt 10:03:00`, `lastPayment 999 USD`, `failedPaymentsCount 2`. The pure
core alone on the same bodies ends `cancelled` with the same last payment; malformed bodies give `ok:false` without throwing.

Ergonomics observed (not defects, see F11/F12): `duplicate` is `false` on a redelivery of a processed row until a consumer
confirmed it, so a host without a consumer never sees `duplicate: true`; rows whose only effect was a mismatch are marked
`processed` and handed to the consumer.

## 5. Findings (ranked)

### F1. important: the README's Postgres lease-claim SQL fails the package's own conformance kit
`README.md:636-664`. The `due` CTE hard-codes `verification_status = 'verified'` ("includePendingVerification: false") and a
three-column scope filter. A store that follows it literally fails 3 of 40 kit cases. Evidence: `readme-sql-claim.unit.test.ts`
(a memory store whose `claimPendingEvidence` forces `includePendingVerification: false`) under `finalreview/kit/repo`:
```
× claims only recoverable rows, oldest first, and honours includeConsumerDelivery  (expected [2 ids] to equal [3 ids])
× two concurrent workers get disjoint rows and a later claim gets the rest           (expected [] to equal [4 ids])
× a lease held by one worker is not claimable by another until it expires           (expected +0 to be 1)
Tests  3 failed | 37 passed (40)
```
The T7 report says the SQL was executed on Postgres 16, not that a store built from it passed the kit. Also `environment`,
`providerCode` and `accountRef` are optional on `ClaimPendingEvidenceInput` (`contracts/lib/recovery.ts:4-11`) and on
`recover()`, while the SQL requires all three (`= $1`): a host calling `recover({ workerId })` gets no rows.
Smallest fix: add `$8 includePendingVerification` (`AND (verification_status = 'verified' OR $8::boolean)`), make the three
scope filters `($1::text IS NULL OR provider_code = $1)`, and say that the kit must pass against the finished store.

### F2. important: README DDL default `consumer_delivery_status = 'pending'` makes reconciliation rows consumer deliveries
`README.md:595-596` (`consumer_delivery_status text NOT NULL DEFAULT 'pending'`). The reference store leaves the field
`undefined` until `markFinancialProcessed` sets `pending` on webhook rows (`webhook-processing-service.ts:648-655`);
reconciliation marks its own rows `processed` without it (`reconciliation-service.ts:1067-1072`). With the DDL default every
row is born `pending`, so reconciliation's `RECONCILIATION.PROVIDER_LOOKUP` rows are claimed and delivered to the host consumer.
Evidence `ddl-probes.mjs` scenario A: reference store `consumer got []`; DDL-default store `recover -> delivered 1`, `consumer got
["RECONCILIATION.PROVIDER_LOOKUP:reconcile"]`. Not data loss, but the consumer gets events of a type the README never
mentions, on every reconciliation lookup. The kit does not pin the insert-time value.
Smallest fix: drop the default (nullable column, map NULL to `undefined`, see F3), or exclude `evidence_kind = 'reconciliation'`
from the `processed` branch of the claim query; add a kit case "a freshly inserted row has no consumerDeliveryStatus".

### F3. important (inference for SQL stores, reproduced with a wrapper): a store that returns `null` for the delivery column never gets a consumer delivery
`webhook-processing-service.ts:650` (`existing?.consumerDeliveryStatus === undefined`) and `webhook-evidence-resume.ts:50`
(`=== undefined`). A nullable SQL column read back as `null` (the natural `pg` mapping) is neither `undefined` nor a known
value: `markFinancialProcessed` never writes `pending`, the row stays `null`, and the README claim query
(`consumer_delivery_status IN ('pending','failed')`) never claims it. Evidence `probes2.mjs` scenario C: after processing
`consumerDeliveryStatus = null`, `recover -> claimed 0`, consumer got 0 events. The type forbids `null`, but nothing at run
time does. Smallest fix: use `== null` in both places (treat `null` like `undefined`) and say in the README that NULL must map to
`undefined` or the column must default to `pending` (which then needs F2).

### F4. important (pre-existing rule, not a regression): a status change in the same second as the stored watermark is dropped and never repaired
`subscription-status-rules.ts:243-248` (`equal_conflict`), applied in `reduce-subscription.ts:261-270`; the webhook lookup
branch reduces the provider snapshot as `source: 'webhook'` (`webhook-processing-service.ts:1094-1095`). PayPal `update_time`
has second precision. Evidence `probes2.mjs` scenario D: stored `active` at `10:00:00`, CANCELLED webhook with `update_time
10:00:00` -> receipt `processed`, stored `active`, with AND without a lookup that returns `cancelled`; `reconcile()` examines 0
rows afterwards (the op is `succeeded`, the row `processed`), so nothing repairs it until a later event. 0.2.1 had the same
rule for webhooks; the lookup branch is new. Smallest fix: in the webhook lookup branch use `source: 'lookup'` (a fresh GET is
the current truth; the reconciliation service already does this), and/or in `evaluateSubscriptionStateOrdering` treat
`equal` with a different status as `apply` when the event is a status event newer by sequence (CANCELLED after ACTIVATED).
At minimum document it under Known limits.

### F5. important: README DDL lacks `item_ref`, which the subscription flows write and read
`README.md:487-534` has no `item_ref` column; `subscription-lifecycle-service.ts:348,444` store `itemRef: input.name` for
products and plans and `:206,220` return it as `name`. A host on the README schema returns `name: ''` for every product and plan
(and must still satisfy the `PaymentOperation` type, which declares `itemRef`). Smallest fix: add `item_ref text` to the DDL
(and a sentence that every non-optional `PaymentOperation` field must be returned, as `null` when unused).

### F6. important: PR body / changeset claim "every PayPal call ... one helper" is true, but the "README DDL was validated" claim is not
`.superpowers/pr-body.md:42` ("the README's SQL ... was run on Postgres 16") reads as validation of the schema; F1/F2/F5 show the
schema and queries diverge from the kit and the reference store. Smallest fix: reword to "executed, not kit-tested" or fix
F1/F2/F5 and run the kit against a Postgres store once (CI job or a one-off).

### F7. minor (PARTIAL part of #7): `resolvePaymentRuntime` boots `live-provider` without credentials when checkout is disabled and an `executionStatus` is present
`resolve-payment-runtime.ts:189-195`: the credentials throw at `:189` requires `!executionStatus`; `!checkoutEnabled(config)`
then returns `live-provider` with no `checkoutCredentials`. Evidence `ddl-probes.mjs` [B]: prod, `capabilityFlags {checkout:
false, subscription: true}`, no creds, configured status -> `live-provider credentials? false`. The six factories still throw
(`buildPaypalSubscriptionExecutor`/`buildPaypalWebhookVerifier` threw `PaymentConfigurationError`) and a hand-built executor
fails closed (`CAPABILITY_UNAVAILABLE`), so boot still fails for factory users. README `:314` ("throws ... when credentials
are absent") is not exact. Smallest fix: drop the `&& !executionStatus` at `:189` (throw whenever `refuseRejectOnly` and
credentials are missing, the kill switch is handled above), and add the case to `resolve-payment-runtime.unit.test.ts`.

### F8. minor: `recordReconciliationFailure` classifies by error-message text
`reconciliation-service.ts:1545` (`rawMessage.includes('Terminal operation status')`), pre-existing, while README `:996` tells
hosts never to substring-match messages. Fix: use `error.rejectionReason === 'invalid_transition'` plus the terminal check.

### F9. minor: intake stores non-string `event_type` / `resource.id` before verification
`webhook-processing-service.ts:522-527` takes `parsed.event_type` and `parsed.resource?.id` untyped. Evidence `probes2.mjs`
[E]: body `{"event_type":{"$gt":""},"resource":{"id":12345}}` -> inserted `eventType: {"$gt":""}`, `resourceId: 12345` (memory
store), then `unsupported`. A SQL text column rejects the insert -> `PERSISTENCE_FAILURE` -> 503 for an unauthenticated poster
(nuisance only; the memory store and verifier cope). Fix: `typeof === 'string' ? value : null` for both.

### F10. minor: dead and deprecated exports
- `subscription-provider-snapshot-fields.ts` (`subscriptionBillingFieldsFromProviderSnapshot`): callers in 0.2.1, none now,
  not even tests; still `export *` from the root (`core/index.ts:56`).
- `DEFAULT_WEBHOOK_MAX_TRANSMISSION_SKEW_MS` (`webhook-processing-service.ts:107`): new in this branch, exported, used nowhere.
- Deprecated and still exported: `applySubscriptionDomainUpdate`, `assertSubscriptionProviderPlanSnapshotConsistent`,
  `evaluateSubscriptionProviderStateOrdering`, `parseSubscriptionResourceStateTimestamp` (no engine callers). Fine for 0.x
  compatibility, but the export pin now freezes them.
- `webhook-evidence-resume.ts:74`: `return verification.unavailableReason ? 'signature_rejected' : 'signature_rejected'`
  (both branches identical, pre-existing).
- `isSubscriptionEvidenceEvent` duplicated verbatim in `webhook-processing-service.ts:263` and `reconciliation-service.ts:120`.

### F11. minor (ergonomics, pre-existing): `duplicate` is never `true` for hosts without a consumer
`markFinancialProcessed` always sets `consumerDeliveryStatus: 'pending'`, and `classifyWebhookEvidenceResume` answers
`resume` until it is `confirmed`, so a redelivery of a processed row reports `duplicate: false` (E2E log line "exact duplicate
redelivery"). README `:716` says the module sets `pending` "when business delivery is still required"; it is set always.
Fix: document, or set `pending` only when the service was built with delivery enabled.

### F12. minor: recovery counts a processed row as `failed` when the consumer throws right after it
`payment-recovery-service.ts:198-207`: `tryDeliverConsumer` throws `PERSISTENCE_FAILURE` on a consumer error, which the batch
loop counts as `failed` although the row was processed (and is retried for delivery). Fix: catch around `tryDeliverConsumer`
inside `recoverClaimedEvidence` and return `'processed'`.

### F13. minor (test gap): nothing pins that reconciliation looks up the subscription id, not the sale id
Mutation `#4e` (`reconciliation-service.ts:957-958` -> `evidence.resourceId ?? ...`) survived the whole src suite because the
lookup fake in `reconciliation-subscription-core.unit.test.ts` ignores the id. Fix: assert the `getSubscription` call argument
equals `I-1` in "never takes the subscription id from a PAYMENT.SALE resource".

### F14. minor (docs): changeset "New exports" list is incomplete
Root runtime additions not named in `.changeset/pure-subscription-core-and-reliability.md:44`: `formatProviderFailureMessage`,
`toVerifiedProcessedPaymentEvent`, `isAwaitingConsumerDeliveryOnly`, `DEFAULT_MAX_CONSUMER_DELIVERY_ATTEMPTS`,
`DEFAULT_SUBMITTED_STALE_KINDS`, `SUBSCRIPTION_COMMAND_NOT_APPLIED`, `HELD_EFFECTS_OVERFLOW`, `SUBSCRIPTION_EFFECTS_HOOK_MISSING`
(from `export-diff.mjs`). Everything else in the changeset checked out (codes +4, `failed_terminal`, required
`providerEventId`, constructor shapes, defaults 100/10/256 KiB).

### F15. minor (docs): README claims that are inferences
`README.md:863` and `:117` "PayPal redelivers for about 3 days with the original time" is taken from PayPal docs, not observed
(the T3 reviewer said the same). Mark it as such or verify against the sandbox before relying on `maxTransmissionAgeMs`.

## 6. Integration risks

(a) **Public API compatibility.** `export-diff.mjs` (0.2.1 dist vs new dist, runtime ESM/CJS and declaration names): root
removed only `LegacyPaymentError`; `/paypal` removed only `PaypalPaymentProvider`, `createPaypalPaymentProvider`,
`invokeCheckoutWhenReady` (runtime) and `CheckoutOperation` (type). Added root type `PaymentStrategy` (T4). Type-level: 4 new
codes, `failed_terminal`, required `providerEventId`, `subscriptionStateJson` on `PaymentOperation`, retry fields, new
`VerifiedProcessedPaymentEvent.rawPayload?`. The documented breaking list is complete; `minor` on 0.x is the right bump.

(b) **Store contract.** No Postgres implementation exists in the repo; the README DDL is the only reference and it does not
pass the kit (F1), diverges on `consumer_delivery_status` (F2/F3) and lacks `item_ref` (F5). Unique indexes, `COALESCE`
ordering indexes, jsonb handling, `SKIP LOCKED` with sort-after-RETURNING are otherwise consistent with the memory store.

(c) **Security.** Raw-body splice: injection attempts (`}}`, two documents, BOM, NUL, comments, arrays) rejected without a PayPal
call; outer keys are ours (`splice.mjs`). OAuth: eviction only when the rejected token is the cached one, single flight,
tokens never in errors (p8). Intake: 256 KiB UTF-8 cap, headers, id mismatch, no echo of values (`fresh.mjs`). Production guards:
F7 gap only. Secrets: `PaymentConfigurationError` lists names only (prod probe "leak check: false"). SSRF: URLs built from
`environment` plus `pathSegment`-encoded ids; `certUrl` only forwarded to PayPal. Prototype pollution: normaliser reads own
properties only; stored-state `extra` spread creates own data properties (no `__proto__` write). ReDoS: every regex is anchored
and length-bounded (`{1,128}`, `{1,30}`, timestamp length <= 40 before the regex). Timing: none applicable. Hostile intake types:
F9.

(d) **Concurrency / exactly-once across restarts.** State writes are compare-and-set on `version`; effects are held in
`subscriptionStateJson` until the hook returns and cleared afterwards; "processed" is written last. E2E covered crash before the
hook (delivered once by recovery) and crash after the hook (not delivered again). Delivery is at-least-once only between hook
return and `clearPendingSubscriptionEffects` (documented). Recovery uses leases; reconciliation and webhook redelivery do not
(documented leftover): two workers can run one evidence row twice, bounded by CAS on the operation. Create path idempotent at
PayPal through `PayPal-Request-Id = operationId`; overlap verified.

(e) **Losing or mis-stating a paying customer's subscription.** F4 (same-second conflicting status, dropped, no repair) is the one
real path; F2/F3 lose consumer deliveries (not state) for some SQL mappings; `gave_up` after ~94 h on rows that wait for the host
(plan mismatch, overflow) is documented and needs the alert the README asks for.

## 7. Quality notes

README spot-check (15 claims): true: entries x node10/node16 (`entries-consumer.test.ts:44-56`), no axios/zod/express
(`dist-entry-identity.test.ts:75-104`), one 401 helper per executor (each executor has exactly one `.request(` call, inside
`resendWithFreshPaypalTokenOn401`), all six factories guard production, `requireWebhookId` default, `gave_up` at ~94 h (63 min +
93 h), `listReconciliationCandidates` webhook-only, `10 * limit` scan, redelivery of a `gave_up` row processed,
`adoptSubscriptionPlan` forgets mismatches, `UPDATE_EXPORT_SURFACE=1` honoured, kill switch builds a pending-storing verifier,
`STORE_CAPABILITY_NOT_CONFIGURED`, `unknown -> submitted` allowed. Not exact: F7 (`:314`), F11 (`:716`), F1 (`:636`), F15.

CI: `ci.yml` smoke step lists all 7 `test/*.test.ts` files that import `dist/` (`architecture-boundary-scanner.ts` is a helper);
`release.yml` verify job runs the same; publish job alone has `contents: write`, `pull-requests: write`, `id-token: write`;
trusted-publishing steps unchanged from 0.2.1; `prepublishOnly` still runs tests inside the publish job (T4 note, accepted
follow-up). Pins verified (section 2, #11).

Changeset: `minor`, accurate except F14. `.changeset/config.json` unchanged.
