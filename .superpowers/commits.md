# Commit messages by task (owner commits; nothing is committed by agents)

## T1 pure subscription core  [status: done, reviewed, fix wave applied, 642 tests]
Files: README.md package.json src/core/lib/__tests__/money.unit.test.ts src/core/lib/__tests__/subscription-transition-policy.unit.test.ts src/core/lib/money.ts src/core/lib/subscription-transition-policy.ts test/dist-package-surface.test.ts tsup.config.ts src/subscription-core/ test/subscription-core-boundary.test.ts test/subscription-entry-consumer.test.ts

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

## T2 adapter hardening (#12 #13 #14)  [done, 683 tests; shares hunks with T1 in money.ts, subscription-transition-policy.ts and its test]
message: see .superpowers/t2-report.md (fix(paypal): harden subscription validation, create options, errors and URL paths)


(T2 message updated after fix wave: body adds "Every id interpolated into a PayPal URL path goes through a shared pathSegment helper (encodes it, rejects empty, . , .. and control-character ids)"; new file src/core/lib/path-segment.ts; see t2-report.md)
## T3 verifier/OAuth/intake/prod boot (#7 #15 #16 #19, package side of #1)  [done, 833 tests]
message: see .superpowers/t3-report.md (fix(paypal): token retry on 401, raw-body verify, intake guards, prod boot checks)


(T3 message updated after fix wave: see end of .superpowers/t3-report.md "Updated commit message")
## T4 packaging/supply chain (#9 #10 #11)  [done, 877 tests, BREAKING for consumers: see t4-report.md]
message: see .superpowers/t4-report.md (build: fix CJS identity, split legacy entry, harden workflows)

## T5 store contract / conformance kit / typed claims / bounded consumer delivery (#6 #21 #23 #24)  [done, 960 tests]
message: see .superpowers/t5-report.md (feat(store): capability store interfaces, conformance kit, typed claims, bounded consumer delivery)
BEHAVIOUR for store implementers: consumer_delivery_status accepts 'failed_terminal'; persist transitionKind (optional); MemoryPaymentReliabilityStore now enforces unique provider ids.

## CI smoke step (owner request)  [done]
file: .github/workflows/ci.yml
adds test/testing-entry-consumer.test.ts and test/dist-declarations.test.ts to the 'Package smoke tests' step (37 tests in that set pass locally)
(include in the T4 commit or the final commit; message line: 'ci: run the /testing and declarations smoke tests')


(T5 message updated after fix wave: see end of .superpowers/t5-report.md "Updated commit message")
## T6a engine on pure core + billing state persistence + sale-id/command bugs + payload hash (#4)  [done, 987 tests]
message: see .superpowers/t6a-report.md (feat(subscription): run engine on the pure core, persist billing state)
BEHAVIOUR for hosts: new nullable store column subscriptionStateJson; UPDATED processed; plan mismatch keeps evidence pending; payment events change state; commands end succeeded/failed; payload-hash mismatch rejected; new last constructor param {onSubscriptionEffects} on WebhookProcessingService and ReconciliationService.


(T6a message updated after fix wave: see end of .superpowers/t6a-report.md; adds adoptSubscriptionPlan, error codes WEBHOOK_PAYLOAD_MISMATCH etc., hook param on lifecycle service)
## T6b fair retry queue, create overlap, create fingerprint, stale submitted (#8 #12 #20 #22 #25)  [done, 1052 tests]
message: see .superpowers/t6b-report.md (fix(reliability): fair retry queue, overlapping create retry, full create fingerprint)
BEHAVIOUR for hosts: new nullable columns attempts/next_attempt_at/retry_status ('gave_up') on operations and evidence; includePendingVerification flag on claimPendingEvidence; listUncertainOperations second arg; new service options retry*/maxAttempts/submittedStaleAfterMs.


(T6b message updated after fix wave: see end of .superpowers/t6b-report.md; maxAttempts default 100, optional reviveUnmatchedEvidence)
