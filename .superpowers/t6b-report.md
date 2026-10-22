# T6b report: fair retry queue (#8, #20), overlapping create retry (#22), fingerprint (#25), stale submitted (#12)

Status: DONE_WITH_CONCERNS (nothing blocks; concerns at the end). Nothing committed, no git state changed.

Gate: `npm run lint && npm run typecheck && npm run build && npm test` green, **109 files / 1052 tests** (baseline 105 / 998; +4 files, +54 tests).

Tests first: the four new test files were written before the code and failed (the fairness and stale files at import, since `retry-backoff` and the new options did not exist; the #22 and #25 files with 9 behavioural failures: `unknown`/no id after the overlap, `OPERATION_CONFLICT` thrown to the claim loser, email retry accepted). The 6 new conformance-kit cases were also run against the T6a memory store (`.superpowers/snap-after-t6a/`): all 6 fail there, none fails for the new store. Original probes rerun against the new `dist/` (copies in `scratchpad/t6b-probe/`, adapted to the T3 intake rule): p5 `#8 foreign=30` reconciles S7 in the first run (`noOps=30,0,0`, S7 active); the 30 verification-unavailable rows + 1 verified/pending case gives `claimed:1, processed:1` in the first `recover(25)` (S9 cancelled); p6 "NEW retry concurrent with in-flight original" ends `stored submitted I-1`, 1 PayPal subscription, same request id; p6b `after race: submitted approval_pending I-1`; email retry `IDEMPOTENCY_CONFLICT`. p3 "crashed after claim" calls `listUncertainOperations(25)` without the new option and still prints `false` by design: the service passes `submittedStaleBefore` (the store-level case with the option is in the kit and the vitest port).

## Files changed by T6b (diff -rq against .superpowers/snap-after-t6a/)

New:
- src/contracts/lib/retry.ts
- src/core/lib/retry-backoff.ts
- src/core/lib/__tests__/fair-retry-queue.unit.test.ts
- src/core/lib/__tests__/stale-submitted-operations.unit.test.ts
- src/core/lib/__tests__/subscription-create-overlap.unit.test.ts
- src/core/lib/__tests__/subscription-create-fingerprint.unit.test.ts

Edited:
- src/contracts/index.ts, src/contracts/lib/operations.ts, src/contracts/lib/evidence.ts, src/contracts/lib/recovery.ts
- src/core/index.ts
- src/core/lib/payment-recovery-service.ts, src/core/lib/reconciliation-service.ts, src/core/lib/subscription-lifecycle-service.ts, src/core/lib/webhook-evidence-resume.ts
- src/core/lib/persistence/memory-payment-reliability-store.ts, src/core/lib/persistence/payment-reliability-store.ts (JSDoc + optional 2nd parameter of `listUncertainOperations`)
- src/testing/lib/run-store-conformance.ts, src/testing/lib/__tests__/store-conformance-detects-broken-stores.unit.test.ts
- src/core/lib/__tests__/payment-recovery-consumer-delivery.unit.test.ts, src/core/lib/__tests__/payment-recovery-service.unit.test.ts, src/core/lib/__tests__/public-error-paths.unit.test.ts, src/core/lib/__tests__/subscription-lifecycle-create-retry.unit.test.ts (see "Tests changed")
- README.md

## What was done

### 1. Fair queue (#8, #20, T6a concern 1)
- Contract (additive): `RetryStatus = 'gave_up'`, `RETRY_STATUS`, `RetryState`; optional `attempts`, `nextAttemptAt`, `retryStatus` on `PaymentOperation`, `ProviderEvidence`, `UpdatePaymentOperationInput`, `UpdateProviderEvidenceInput` and the admin view; `ClaimPendingEvidenceInput.includePendingVerification?`; `listUncertainOperations(limit, options?: { submittedStaleBefore?, submittedStaleKinds? })`; `DEFAULT_SUBMITTED_STALE_KINDS`.
- `retry-backoff.ts`: defaults (`retryBaseDelayMs` 60000, `retryMaxDelayMs` 3600000, `maxAttempts` 20, `submittedStaleAfterMs` 300000), `resolveRetryBackoffPolicy` (integers > 0, max >= base, `PaymentConfigurationError` with the field, as T3), `nextRetryDeferral` (delay `min(max, base * 2^(attempts-1))`; at `maxAttempts` → `gave_up`, `nextAttemptAt` null), `isRetryDue`.
- Store contract and memory store: every candidate list returns only rows with `retryStatus` null and `nextAttemptAt` null or reached, `ORDER BY COALESCE(nextAttemptAt, receivedAt|createdAt), id`. `claimPendingEvidence` honours `includePendingVerification: false`; explicit `evidenceIds` ignore `nextAttemptAt` (never `gave_up`). `isRecoverableEvidenceRow` excludes `gave_up` rows unless only consumer delivery is left. `listReconciliationCandidates` lists only `webhook` evidence.
- `PaymentRecoveryService` (new options in the dependencies): never claims verification-pending rows; after each attempt a row that still needs work is released with the deferral in the same write; a failed consumer delivery gets only `nextAttemptAt` (its terminal state stays `failed_terminal`); a row that became processed clears an old `nextAttemptAt`.
- `ReconciliationService` (new 4th constructor argument `ReconciliationServiceOptions`): evidence phase pages through due candidates; `limit` counts rows that correlate to an operation, rows that correlate to none are deferred without using it (scan bounded by `10 * limit`, stops when a page brings nothing new, so a store ignoring `nextAttemptAt` cannot loop). Every candidate still a candidate afterwards is deferred (evidence via `updateEvidence`, operations via CAS `updateOperation`, a version conflict is ignored). Plan-mismatch, overflow and hook-missing rows are bounded the same way (tests).
- Kit: the two "oldest first by createdAt" cases are replaced by nextAttemptAt-contract cases for both lists, plus cases for `claimPendingEvidence` order/backoff/`evidenceIds`, `includePendingVerification`, retry field patch semantics, and stale `submitted`. New broken stores: `IgnoresNextAttemptAt`, `NeverIncrementsAttempts` (no `attempts` column), `NeverGivesUp` (no `retry_status` column), `IgnoresPendingVerificationFlag`, `NoStaleSubmittedOperations`; each fails the expected case.
- Ports: p5 30 foreign rows, one `reconcile(25)`; p5 30 verification-unavailable + 1 verified/pending, first `recover(25)`; plus backoff doubling/cap, give-up, uncertain operation give-up, newer operation reached behind a deferred one, recovery deferral with a newer row on the next run, `recoverEvidence` bypass, option validation.

### 2. #22 overlapping create retry
- First create path: losing the claim race (`OPERATION_CONFLICT`) returns the stored row; the provider result is stored by the new `persistSubscriptionCreateResult`, used by both the first call and the retry: on a version/owner conflict it re-reads; a row that already has a provider subscription id (or is terminal) is returned, otherwise the result is written on the fresh version (lease cleared). A provider failure of the first call writes `unknown` only if the row is still at its claimed version (`handleFailure(..., { pinVersion: true })`), else returns the stored row. The old `persistSubscriptionCreateExecutionTransition` is replaced.
- Ported p6/p6b with controlled deferreds: original first, retry first, original timeout after/before the retry stored, retry timeout after the original stored, two concurrent creates with one key. All end `submitted I-1` with the approval URL, one PayPal subscription, one PayPal-Request-Id; a third retry returns I-1 without a POST.

### 3. #25 fingerprint
- `buildSubscriptionCreateCommandFingerprint` adds `subscriberEmail` when set (customId, shippingPreference, brandName, userAction, productType, return/cancel URLs and the plan reference were already included since T2). The create request has no trial/setup parameters (those are plan fields), so nothing else applies.
- Compatibility: a stored row whose fingerprint equals the email-less one and whose `subscriberEmail` equals the request email matches (replay and retry), so 0.2 rows keep working; another email is still `IDEMPOTENCY_CONFLICT`. Requests without email keep the T2 fingerprint (test).

### 4. #12 stale submitted
- `listUncertainOperations(limit, { submittedStaleBefore, submittedStaleKinds })` also lists `submitted` operations of those kinds (default `subscription`, `checkout`) without `providerReferenceId`, `updatedAt <= submittedStaleBefore`, execution lease missing or expired. The reconciliation service passes `now - submittedStaleAfterMs`; such an operation without any provider id is moved to `unknown` (`PROVIDER_UNCERTAIN`, `subscriptionStatus: 'unknown'` for subscriptions), recorded as the existing `MISSING_PROVIDER_REFERENCE` no-op and deferred. Test: a create whose worker died is listed after 5 min, marked `unknown`, and `retrySubscriptionCreate` then stores the subscription with the same request id.

### README
"Implementing a store": new required flag `includePendingVerification`, retry columns (`attempts`, `next_attempt_at`, `retry_status` with the CHECK value `'gave_up'`), order, `webhook`-only candidates, suggested indexes, stale `submitted` option, clock note, "Retry backoff and giving up" (options, formula, what stays pending by design, how to see and reset `gave_up`, reconcile budget). Recovery section (backoff, explicit ids, pending verification not claimed). New "Subscription create: idempotency and retries" section.

## Rulings
- Ruling: `gave_up` is a value of a new nullable `retryStatus` column on operations and evidence, not a new `PaymentOperationStatus`/`EvidenceProcessingStatus` value. The row keeps its status (`unknown`, `unmatched`, `pending`), so a host reset is "clear the three columns", nothing is lost, and no exhaustive switch or transition table breaks.
- Ruling: verification-pending rows are excluded from recovery claims (flag), not deferred: recovery can never verify them. Unmatched and other unfinished rows are deferred with backoff.
- Ruling: `reconcile(limit)` refills the batch: rows that correlate to no operation do not use the budget (cheap store lookups), bounded at `10 * limit` scanned rows. This is what makes p5 pass in one run; recovery keeps a single claim per run (newer rows are reached on the next run because skipped rows are deferred).
- Ruling: a failed consumer delivery is deferred (`nextAttemptAt` from `consumerDeliveryAttempts`), its cap and terminal status stay `maxConsumerDeliveryAttempts` / `failed_terminal`; `attempts`/`gave_up` are not used for delivery.
- Ruling: `claimPendingEvidence` with explicit `evidenceIds` (`recoverEvidence`) ignores `nextAttemptAt` but not `gave_up`.
- Ruling: `listReconciliationCandidates` lists only `webhook` evidence. Reconciliation's own `RECONCILIATION.*` rows were candidates while their operation was `unknown`, so each run repeated the provider lookup once per accumulated row; the operation itself is listed by `listUncertainOperations`. Recovery still claims those rows (held-effects redelivery).
- Ruling: stale `submitted` is limited to kinds with a create retry path (`subscription`, `checkout`, overridable with `submittedStaleKinds`): payout items wait in `submitted` without a reference by design and must not be flipped to `unknown`. "Older than the lease" is measured on `updatedAt` (the claim write). Reconciliation marks such a row `unknown` only when it has no kind-specific provider id; it does not call PayPal create.
- Ruling: the reconciliation and recovery services increment `attempts` read-modify-write; two reconcile workers on the same evidence row (reconciliation takes no lease, pre-existing) can lose one increment. Operations use the CAS `updateOperation`, so no increment is lost there (a conflict skips the deferral).
- Ruling: the engine never clears `retryStatus`/`attempts` itself (except recovery clearing an old `nextAttemptAt` once a row only awaits delivery); a host create retry on a `gave_up` operation still works because `retrySubscriptionCreate` does not read the retry columns.
- Ruling: #25 legacy match uses the stored `subscriberEmail` (0.2 stored it), so upgraded hosts can replay/retry 0.2 rows; a 0.2 row without stored email and a request with email stays a conflict (that is #25).

## Behaviour changes for hosts
- New nullable store columns on operations and evidence: `attempts` (integer), `next_attempt_at` (timestamp), `retry_status` (text; a CHECK constraint must allow `'gave_up'`). Persist them through `updateOperation`/`updateEvidence` and filter/order the three candidate lists as documented; run the kit. A store without them keeps the old starvation (no backoff, never gives up), and the kit fails it.
- `claimPendingEvidence` receives `includePendingVerification: false` from recovery and must honour it. Recovery no longer claims verification-pending rows (was: claimed and `skipped`).
- Candidate order changes from `receivedAt`/`createdAt` to `COALESCE(nextAttemptAt, receivedAt|createdAt)`; `listReconciliationCandidates` lists only `webhook` evidence.
- `listUncertainOperations` gets an optional second argument; with it, stale `submitted` subscription/checkout creates are listed and reconciliation moves them to `unknown` (`PROVIDER_UNCERTAIN`) after `submittedStaleAfterMs`.
- Unsuccessful reconciliation/recovery rows are not retried on the next run but after the backoff (1 min doubling to 1 h); after 20 attempts they get `retryStatus: 'gave_up'` and are not selected again until reset. This includes rows pending by design (`SUBSCRIPTION_PLAN_MISMATCH`, `HELD_EFFECTS_OVERFLOW`, `SUBSCRIPTION_EFFECTS_HOOK_MISSING`). A failed consumer delivery also waits for the backoff before the next attempt.
- Deferring an operation bumps its `version` (CAS `updateOperation`).
- `reconcile(limit)` can examine more than `limit` evidence rows per run (unmatched rows do not use the budget, up to `10 * limit`); `examined` counts each examined row.
- Subscription create fingerprint includes the subscriber email: a replay/retry with the same key and another email (or adding/removing the email) is `IDEMPOTENCY_CONFLICT`. Rows from 0.2 match when the email equals the stored `subscriberEmail`.
- A create whose claim is lost to a concurrent create with the same key returns the stored row instead of throwing `OPERATION_CONFLICT`; overlapping original/retry calls never leave the row `unknown` without the id, and a provider failure of the first call no longer overwrites a row a retry moved on.
- New exports (root): `RETRY_STATUS`, `RetryStatus`, `RetryState`, `ListUncertainOperationsOptions`, `DEFAULT_SUBMITTED_STALE_KINDS`, `ReconciliationServiceOptions`, and from `retry-backoff`: `DEFAULT_RETRY_BASE_DELAY_MS`, `DEFAULT_RETRY_MAX_DELAY_MS`, `DEFAULT_RETRY_MAX_ATTEMPTS`, `DEFAULT_SUBMITTED_STALE_AFTER_MS`, `RetryBackoffOptions`, `RetryBackoffPolicy`, `RetryDeferral`, `resolveRetryBackoffPolicy`, `resolvePositiveDurationMs`, `retryDelayMs`, `nextRetryDeferral`, `isRetryDue`.

## Tests changed because they encoded a defect
- `payment-recovery-service.unit.test.ts` "skips evidence still awaiting provider verification when claimed" → "does not claim evidence still awaiting provider verification" (claimed 0 / skipped 0; was 1 / 1: the #20 pattern of claiming a row only to skip it).
- `payment-recovery-consumer-delivery.unit.test.ts` (p7 cap, default cap, at-least-once) and `public-error-paths.unit.test.ts` (sanitized delivery, retry after failure): they re-claimed a failed delivery on the very next run; they now move the fake clock past the backoff (or reset `nextAttemptAt` like a host) between runs. Assertions unchanged.
- `subscription-lifecycle-create-retry.unit.test.ts`: the seeded 0.2-style row now stores `subscriberEmail` (0.2 stored it); without it a retry with an email is exactly the #25 case and is now rejected.

## Concerns
1. Reconciliation takes no lease on evidence (pre-existing), so two concurrent `reconcile()` workers can process one row twice and lose an `attempts` increment; the cap is then reached a little later. A lease for reconciliation would be a separate change.
2. The memory store compares `nextAttemptAt` with its own clock, the services compute it with theirs; a SQL store using `now()` sees the skew as a shift of the retry time only (documented).
3. The root export surface grows (whole `retry-backoff` module); T7's explicit export list may keep only the defaults, the types and `RETRY_STATUS`.
4. Formatting: new files formatted with the local prettier 3.9.10 (`--single-quote --trailing-comma all --print-width 100`); `memory-payment-reliability-store.ts` and `subscription-lifecycle-service.ts` were prettier-clean before T6b and were formatted whole (only my hunks changed); other edited files were hand-formatted and checked hunk by hunk (remaining prettier differences there are pre-existing).
5. T7: changeset must list the behaviour changes above; README has the new sections but T7 owns the polish (e.g. a SQL migration snippet for the three columns and indexes).

## Commit message
```
fix(reliability): fair retry queue, overlapping create retry, full create fingerprint

- Reconciliation and recovery no longer starve: operations and evidence
  get nullable attempts / nextAttemptAt / retryStatus columns; a row
  still unresolved after its attempt is deferred with exponential
  backoff (retryBaseDelayMs 60 s, retryMaxDelayMs 1 h) and gets
  retryStatus 'gave_up' after maxAttempts (20). Candidate lists return
  due rows only, ORDER BY COALESCE(nextAttemptAt, created/received).
  Recovery never claims verification-pending rows
  (includePendingVerification); reconcile() refills its batch past
  foreign unmatched rows, so a matchable event behind them is
  reconciled in the same run. Memory store, conformance kit cases and
  broken-store tests, README.
- A create retry overlapping the in-flight original stores PayPal's
  response whichever call gets it; the other call returns the stored
  row and a timeout never overwrites it. The loser of a concurrent
  create claim returns the stored row.
- The subscription create fingerprint includes the subscriber email:
  another email for the same key is IDEMPOTENCY_CONFLICT (0.2 rows
  still match by their stored email).
- listUncertainOperations can list stale submitted creates; after
  submittedStaleAfterMs (5 min) reconciliation marks a create that
  crashed after its claim unknown so it can be retried.

Refs #8, #12, #20, #22, #25

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
```

## Fix wave (review .superpowers/t6b-review.md, findings 1-7, 9 and the type part of 8)

Gate: `npm run lint && npm run typecheck && npm run build && npm test` green, **110 files / 1079 tests** (before the wave: 109 / 1052).
Tests first: the new file `src/core/lib/__tests__/fair-retry-fix-wave.unit.test.ts` and the P4 cases in `subscription-create-overlap.unit.test.ts` were run before the fixes: 17 failures (default cap 20, P2 gave up, no revive, evidence/op re-looked-up, retry state not cleared, NaN RangeError, unbounded options, P4 409/422 `failed`). Three mutation-survivor tests (limit lookups, 10 x limit scan, failed delivery not re-claimed) passed at once: they pin behaviour that was already right (M30, M33, M21). The new kit case "webhook-only candidates" fails for a new broken store `ListsReconciliationEvidence`. Review probes rerun on the new dist: P1 `gave_up at attempt 100 after 94.05 h`, `nextRetryDeferral(NaN)` = attempts 1; P2 after 25 h `attempts 25 retryStatus null`, op appears -> `active`, redelivered row `processed null`; P4 `retry -> unknown | original -> submitted I-1 url=... | stored submitted I-1 | PayPal subs created 1`.

Changed-files delta (against the first T6b hand-over):
- new: src/core/lib/__tests__/fair-retry-fix-wave.unit.test.ts
- newly edited: src/core/lib/subscription-evidence-application.ts, src/core/lib/webhook-processing-service.ts
- edited again: src/contracts/lib/recovery.ts, src/core/lib/retry-backoff.ts, src/core/lib/payment-recovery-service.ts, src/core/lib/reconciliation-service.ts, src/core/lib/subscription-lifecycle-service.ts, src/core/lib/persistence/memory-payment-reliability-store.ts, src/core/lib/persistence/payment-reliability-store.ts, src/testing/lib/run-store-conformance.ts, src/testing/lib/__tests__/store-conformance-detects-broken-stores.unit.test.ts, src/core/lib/__tests__/fair-retry-queue.unit.test.ts (default 20 -> 100), src/core/lib/__tests__/subscription-create-overlap.unit.test.ts, README.md

1. `gave_up` and real events: `DEFAULT_RETRY_MAX_ATTEMPTS` 20 -> 100. Schedule 1, 2, 4, 8, 16, 32 min then 60 min: the 100th attempt is 5643 min (94.05 h) after the first failure, beyond PayPal's ~72 h redelivery window with ~22 h margin (documented in the constant and README). README no longer says "nothing is lost": a `gave_up` row is kept but nothing processes it until a host resets the three columns; alert on `retry_status = 'gave_up'`. Revive: new optional store method `reviveUnmatchedEvidence({ providerCode, accountRef, environment, resourceId })` (memory store, JSDoc, README, optional kit case) clears the retry columns of verified `unmatched` webhook rows of that resource; `SubscriptionLifecycleService` calls it (best effort) after a create result binds the PayPal subscription id (first call and retry). Tests: P1 schedule, P2 (25 h of hourly runs, then the operation appears and the event is processed), revive of a row that already gave up via a later create.
2. P4: the smallest change is in the retry path. When the retry took over a `submitted` row without an execution lease (a first-path claim that may still be in flight), a non-uncertain failure (409, 422, any terminal 4xx) is recorded `unknown`, not `failed`; the first call's 201 then stores the id and approval URL through the existing persist path. A retry from `unknown` still fails on a terminal 4xx (test). Tests for 409 and 422.
3. Mutation survivors: at most `limit` PayPal lookups per run (8 matchable rows, `reconcile(3)`), at most `10 * limit` examined foreign rows, a failed consumer delivery not re-claimed before its `nextAttemptAt` (no clock move), a row processed by recovery keeps no retry state and is delivered next, evidence whose operation is still `unknown` is deferred together with the operation (fix: the evidence phase now also defers or clears its related operation once per run, since the operation phase skips it; this was M26, the operation was looked up again every run). Kit case "lists only webhook evidence" + broken store.
4. `nextRetryDeferral`/`retryDelayMs`: a stored `attempts` that is not a non-negative safe integer (NaN, Infinity, negative, text) counts as 0; delays are clamped to `MAX_RETRY_DELAY_MS` even for a hand-built policy. Options: `retryBaseDelayMs`/`retryMaxDelayMs` at most `MAX_RETRY_DELAY_MS` (7 days), `maxAttempts` at most `MAX_RETRY_ATTEMPTS` (1,000,000); violations throw `PaymentConfigurationError` at construction. Tests.
5. README: both services share the row's counter; configure them with the same retry options (smaller cap wins otherwise).
6. Retry columns are cleared when a row resolves: `markFinancialProcessed` (webhook path, also a `gave_up` row processed by a PayPal redelivery), recovery after an attempt that leaves the row resolved (all three cleared; a failed delivery keeps only its `nextAttemptAt`), reconciliation for evidence that left the candidate set (not `pending`/`unmatched`) and for operations no longer uncertain, `applySubscriptionEvents` (any subscription state write that leaves `unknown`), and the lifecycle create result. Operations are cleared with a CAS `updateOperation` (`clearResolvedOperationRetryState`; a conflict returns the stored row). Tests.
7. README: the email is compared verbatim (`A@B.c` vs `a@b.c` vs ` A@B.c` conflict, fail closed).
8. `PaymentEvidenceAdminView.retryStatus` is `RetryStatus | null`. The explicit root export list is left to T7 (new in this wave: `MAX_RETRY_DELAY_MS`, `MAX_RETRY_ATTEMPTS`, `CLEARED_RETRY_STATE`, `hasRetryState`, `clearResolvedOperationRetryState`, `ReviveUnmatchedEvidenceInput`).
9. README: the overlap bullet now says what happens on a terminal 4xx; `submittedStaleAfterMs` must exceed `requestTimeoutMs` (default 10 s) times the executor's internal attempts, and a slow create marked `unknown` is still completed by its own later success.

Rulings (fix wave)
- Ruling: count-based cap kept (100) instead of a time-based `giveUpAfterMs`: one option fewer, and the documented schedule gives ~94 h with the defaults.
- Ruling: revive matches `resourceId` = subscription id, so it covers `BILLING.SUBSCRIPTION.*` events; a `PAYMENT.SALE.*` row (resource = sale id) is not revived and waits for its own backoff. Revive is optional for host stores and best effort (errors ignored, the create result is already stored).
- Ruling: P4 fixed in the retry path, not by giving the first-path claim a lease: the first-path claim keeps `claimOperationForExecution` (no change to the claim contract or the lease timing), and a retry overlapping a lease-less `submitted` row cannot turn the row terminal. A genuinely invalid request then needs one more retry (from `unknown`) to reach `failed`.
- Ruling: recovery clears retry state only for rows that are no longer `pending`/`unmatched`, so a still-pending row that gave up keeps its `gave_up` marker.

Behaviour changes for hosts (added by the fix wave)
- Default `maxAttempts` is 100 (about 94 h of retries), not 20.
- `retryBaseDelayMs`/`retryMaxDelayMs` above 7 days and `maxAttempts` above 1,000,000 are rejected at construction.
- Engine writes clear `attempts`/`nextAttemptAt`/`retryStatus` when a row resolves (an extra CAS `updateOperation` on an operation that had retry state).
- New optional store method `reviveUnmatchedEvidence`.
- A create retry that overlapped a lease-less first call and gets a terminal 4xx leaves the operation `unknown` (was `failed`).

### Updated commit message (whole T6b)
```
fix(reliability): fair retry queue, overlapping create retry, full create fingerprint

- Reconciliation and recovery no longer starve: operations and evidence
  get nullable attempts / nextAttemptAt / retryStatus columns; a row
  still unresolved after its attempt is deferred with exponential
  backoff (retryBaseDelayMs 60 s, retryMaxDelayMs 1 h, at most 7 days)
  and gets retryStatus 'gave_up' after maxAttempts (100, about 94 h,
  beyond PayPal's 3-day redelivery). Candidate lists return due rows
  only, ORDER BY COALESCE(nextAttemptAt, created/received), webhook
  evidence only. Recovery never claims verification-pending rows
  (includePendingVerification); reconcile() refills its batch past
  foreign unmatched rows, so a matchable event behind them is
  reconciled in the same run. Retry columns are cleared when a row
  resolves; binding a subscription id on create revives its unmatched
  events (optional reviveUnmatchedEvidence). Memory store, conformance
  kit cases and broken-store tests, README.
- A create retry overlapping the in-flight original stores PayPal's
  response whichever call gets it; the other call returns the stored
  row, a timeout never overwrites it, and a retry's terminal 4xx while
  the first call may be in flight records unknown, so the original's
  201 is still stored. The loser of a concurrent create claim returns
  the stored row.
- The subscription create fingerprint includes the subscriber email
  (compared verbatim): another email for the same key is
  IDEMPOTENCY_CONFLICT (0.2 rows still match by their stored email).
- listUncertainOperations can list stale submitted creates; after
  submittedStaleAfterMs (5 min) reconciliation marks a create that
  crashed after its claim unknown so it can be retried.

Refs #8, #12, #20, #22, #25

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
```
