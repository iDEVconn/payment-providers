# T6b review

Verdict: **APPROVED_WITH_FIXES**

Gate observed (working tree, `npm run lint && typecheck && build && test`): lint 0 problems, typecheck clean, build OK,
**109 files / 1052 tests passed**. Working tree `src/` equals `.superpowers/snap-after-t6b/src`. Removed `it(`/`expect(` in
the diff: only the three replaced cases (pending-verification recovery, two kit ordering cases), each replaced by a
stricter one.

Original probes re-run against the new `dist/` (implementer's adapted copies in `scratchpad/t6b-probe/`):
p5 `#8 foreign=30 ... S7=active noOps=30,0,0`; 30 verification-unavailable + 1 verified/pending: first `recover(25)` =
`claimed:1, processed:1`, S9 cancelled; p6 "retry concurrent with in-flight original" -> `stored submitted I-1`, POSTs 2 with
the same request id, 1 PayPal subscription; p6b `after race: submitted approval_pending I-1`; email retry
`IDEMPOTENCY_CONFLICT`. All as reported.

## Mutation testing (the "only failed at import" weakness)

Scratch copy `scratchpad/t6breview/repo`, runner `scratchpad/t6breview/mutate.mjs`, full `src` suite per mutation.
The weakness is **disproved**: the fairness and stale-submitted files fail on behaviour for every core mutation.

| Mutation | Killed by |
| --- | --- |
| M1 every list ignores `nextAttemptAt` (`isRetryDue`) | fair-retry-queue (5 cases), kit (3 ordering cases), broken-store tests |
| M1b/M1c/M1d only reconciliation list / uncertain list / `claimPendingEvidence` ignores it | fair-retry-queue + kit (each) |
| M2 attempts never incremented | fair-retry-queue (5) |
| M3 never `gave_up` | fair-retry-queue (4) |
| M4 unmatched rows consume the budget (no refill) / M4b single page / M20 scan factor 1 | fair-retry-queue "30 foreign rows" |
| M5 recovery passes `includePendingVerification: true` / M5b store ignores the flag | fair-retry-queue p5 port, payment-recovery-service; M5b also kit |
| M6 backoff 0 / M6b no max cap / M6c no doubling | fair-retry-queue (M6b also consumer-delivery default cap) |
| M7 stale listing off (store) / M7b service omits option / M7c ignores live lease / M7d ignores `providerReferenceId` / M24 not marked unknown / M27 no `subscriptionStatus` / M32 all kinds stale | stale-submitted-operations and/or kit |
| M8 claim loser throws | create-overlap "two concurrent creates" |
| M9 fingerprint without email / M10 no 0.2 match / M10b 0.2 match ignores stored email / M29 create path ignores 0.2 fingerprint | create-fingerprint (+ create-retry for M10) |
| M11 create result loses on conflict / M12 failure overwrites (no `pinVersion`) | create-overlap (2 cases each) |
| M13 recovery never defers / M14 reconcile never defers operations / M15 never defers evidence | fair-retry-queue (+ stale for M14) |
| M16/M16b order ignores `nextAttemptAt` | kit ordering cases |
| M17 reconciliation-kind rows listed again | fair-retry-queue only (kit does not check it) |
| M18/M18b/M19/M25 `gave_up` handling | kit + fair-retry-queue |
| M22 options accept non-integers | fair-retry-queue validation |

**Survivors:** M21 (failed consumer delivery not deferred), M23 (processed row keeps an old `nextAttemptAt`, delaying
delivery), M26 (evidence whose operation is still `unknown` not deferred: re-examined, and re-looked-up at PayPal, every run),
M30 (scan bound removed), M33 (`limit` no longer bounds correlated rows = PayPal lookups per run), M28/M31 (near-equivalent).
Kit gap: M17 is caught only by a service test; a SQL store that lists `reconciliation` evidence passes the kit.

## Findings

### 1. important: `gave_up` can drop a real event; default cap is ~14 h, README says "nothing is lost"
`src/core/lib/retry-backoff.ts:9` (`DEFAULT_RETRY_MAX_ATTEMPTS = 20`), `README.md:429`.
Probe `scratchpad/t6breview/probes.mjs` P1/P2:
```
P1 default schedule: gave_up at attempt 20 after 14.05 h from first failure
P2 first delivery: unmatched  (receiveWebhook returns normally -> host acks 200 -> PayPal does not redeliver)
P2 after ~25h of hourly reconcile: unmatched attempts 20 retryStatus gave_up
P2 op appears later: reconcile+recover -> approval_pending recover {"claimed":0,...}
P2 PayPal redelivers same event id: processed -> op active | row processed gave_up
```
A redelivery of a `gave_up` row is processed (resume path ignores retry columns), but an acked `unmatched` event is never
redelivered, and nothing revives the row when the operation becomes matchable later (e.g. a create recovered by the host's
retry hours after the claim crashed, or a PayPal lookup outage over a weekend). Before T6b such a row stayed a candidate
forever. The cap (14 h) is far shorter than PayPal's own 3-day redelivery horizon.
Smallest fix: (a) default to at least the 3-day horizon: with 1 min doubling to 1 h, `maxAttempts` >= 78
(63 min + 71 x 60 min ~ 72 h), or a time-based `giveUpAfterMs` (default 72 h) measured from the first attempt; and
(b) README: replace "so nothing is lost" with "the row is kept, but nothing processes it until a host resets it; alert on
`retry_status = 'gave_up'`". Optional: when an operation binds a provider subscription id, clear the retry columns of
`unmatched` webhook evidence with that `resource_id`.

### 2. important: an overlapping retry's terminal 4xx discards the original's created subscription (#22 not closed for errors)
`src/core/lib/subscription-lifecycle-service.ts:1231` (returns a terminal row as stored), `:1266-1274` (retry maps a
non-uncertain 4xx to `failed`), first-path claim `:663` takes no execution lease, so the retry runs concurrently (p6:
`status at retry submitted lease null`). `src/paypal/lib/paypal-subscription-executor.ts:85` maps every other 4xx (409,
422, ...) to `PROVIDER_TERMINAL_REJECTION`.
Probe P4 (retry gets a 4xx such as a duplicate-request/in-progress answer while the original is in flight, then the
original gets 201):
```
P4 retry 4xx then original 201: retry -> failed null | original -> failed null url=null | stored failed null | PayPal subs created 1
```
The PayPal subscription exists, its approval URL is lost, the row is terminal `failed` and cannot be retried. The task
spec says "the winner always persists the provider response". Interleavings that ARE correct (verified by tests and
mutations M11/M12): original first, retry first, original timeout after/before the retry stored, retry timeout after the
original stored, both uncertain (whichever writes `unknown` last, the other pinned/conflicting call returns it), two
concurrent creates; no second PayPal request id is ever sent, so two distinct subscriptions cannot result.
Smallest fix: in `handleSubscriptionCreateProviderFailure`, when the call is a retry that overlaps a first-path claim
(row was `submitted` without lease when the retry took it, i.e. another call may be in flight), record a non-uncertain
4xx as `unknown` (retryable) instead of `failed`; or make the first-path claim take the execution lease so the retry's
existing "lease in flight -> return stored row" branch applies. Add the P4 case to `subscription-create-overlap.unit.test.ts`.

### 3. minor: test gaps for budget and delivery backoff (mutation survivors)
`src/core/lib/reconciliation-service.ts:305-307` (M30, M33: nothing pins the `10 * limit` scan bound or that at most
`limit` correlated rows, i.e. PayPal lookups, are processed per run), `:343` (M26), `src/core/lib/payment-recovery-service.ts:169,172`
(M21, M23: consumer-delivery tests advance the clock past the backoff, so "not deferred" passes too).
Fix: a reconcile test with `limit + 5` matchable rows asserting `getSubscription` calls == `limit` and one with
`> 10 * limit` foreign rows asserting `examined == 10 * limit`; a delivery test asserting the row is NOT claimed before
`nextAttemptAt`; a kit case that `listReconciliationCandidates` excludes `evidenceKind: 'reconciliation'`.

### 4. minor: backoff math can throw and abort a whole run
`src/core/lib/retry-backoff.ts:104` and `:41`. Probe P1:
```
nextRetryDeferral(NaN) = THROW RangeError: Invalid time value
retryMaxDelayMs = Number.MAX_SAFE_INTEGER accepted at construction -> nextRetryDeferral(50) THROW RangeError
```
A non-numeric `attempts` from a host store, or a `retryMaxDelayMs` above ~8.6e15 ms, throws inside `reconcile()`/
`recover()` (no per-row catch), aborting the run at the same row every time. Large `attempts` and negative values are
handled (`retryDelayMs(1e9)` = cap, `(-3)` -> attempts 1). No jitter: acceptable, PayPal calls stay bounded by `limit`.
Fix: treat non-finite `attempts` as 0; validate `retryMaxDelayMs` <= e.g. 30 days.

### 5. minor: recovery and reconciliation share one `attempts`/`nextAttemptAt` on verified `unmatched` evidence
`src/core/lib/payment-recovery-service.ts:264`, `src/core/lib/reconciliation-service.ts:350`. Probe P3 (both services,
`maxAttempts: 4`, alternating hourly): `attempts 4 gave_up` - both consume one counter and one schedule; with different
options the smaller cap wins and a recovery attempt hides the row from reconciliation until its due time. Read-modify-write
on evidence in reconcile (no lease) can also lose increments (report concern 1; it only delays `gave_up`).
Fix: README sentence "configure both services with the same retry options; they share the row's counter".

### 6. minor: retry columns are never cleared after a row resolves
Probe `probe7.mjs`: a create marked stale then answered by PayPal ends `submitted I-1 attempts=1 next=<future>`; P2 ends
`processed ... gave_up`. A later uncertain episode of the same operation starts mid-schedule, and admin views show
processed rows as `gave_up`. Fix: in `deferEvidenceIfStillCandidate` / `deferOperationIfUnresolved` (they already read
the fresh row), write `attempts/nextAttemptAt/retryStatus = null` when the row is no longer a candidate and has them set.

### 7. minor: email in the fingerprint is compared verbatim
`src/core/lib/subscription-lifecycle-service.ts:138` (`buildSubscriptionCreateCommandFingerprint`).
Probe P5: stored `A@B.c`; replay with `a@b.c` or ` A@B.c` -> `IDEMPOTENCY_CONFLICT`; absent vs `undefined`/`null` for
optional fields and key order are canonical (replay OK). Fails closed, keeps 0.2 compatibility; document "pass the email
exactly as on the first call" in the README section.

### 8. minor: export surface and a loose type
`src/core/index.ts:34` exports the whole `retry-backoff` module from the root: new public symbols `DEFAULT_RETRY_BASE_DELAY_MS`,
`DEFAULT_RETRY_MAX_DELAY_MS`, `DEFAULT_RETRY_MAX_ATTEMPTS`, `DEFAULT_SUBMITTED_STALE_AFTER_MS`, `RetryBackoffOptions`,
`RetryBackoffPolicy`, `RetryDeferral`, `resolveRetryBackoffPolicy`, `resolvePositiveDurationMs`, `retryDelayMs`,
`nextRetryDeferral`, `isRetryDue`, plus `RETRY_STATUS`, `RetryStatus`, `RetryState`, `ListUncertainOperationsOptions`,
`DEFAULT_SUBMITTED_STALE_KINDS`, `ReconciliationServiceOptions`. T7's explicit list should drop the five helper functions.
`src/contracts/lib/recovery.ts:82` types the admin view's `retryStatus` as `string | null` instead of `RetryStatus | null`.

### 9. minor: README accuracy
`README.md:429` "nothing is lost" (finding 1); `README.md:569` "the other returns the stored row" is not true when one
call gets a terminal 4xx (finding 2). The stale `submitted` default (5 min) is consistent with the 10 s default request
timeout, and probe P7 shows a slow in-flight create marked `unknown` is still overwritten by its own later success (or left
`unknown` on timeout), so a short `submittedStaleAfterMs` cannot cause a duplicate subscription; say in the README that it
must exceed `requestTimeoutMs` times the executor's internal attempts.

## Scratch artefacts
- `scratchpad/t6breview/mutate.mjs`, `mut.log`, `mutations*.txt`
- `scratchpad/t6breview/probes.mjs` (P1-P6), `probe7.mjs`
