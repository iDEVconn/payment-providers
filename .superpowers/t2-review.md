# T2 review

Verdict: APPROVED_WITH_FIXES

Results: lint clean, typecheck clean, build OK, test 86 files / 683 tests passed.

Findings
1. important - src/paypal/lib/paypal-*-executor.ts (all encodeURIComponent sites, e.g. paypal-subscription-executor.ts:270,348,397,427; checkout:146,213,356,417; payout:213,312,330,350; seller:162,186,240): `encodeURIComponent` leaves `.` and `..` unchanged and an empty id yields an empty segment. Probe: `new URL('https://a/v1/billing/subscriptions/' + encodeURIComponent('..') + '/cancel').href` = `https://a/v1/billing/cancel` (traversal out of the resource); empty id gives `/v1/billing/subscriptions//cancel`. The hostile-id test only uses `../../../v1/...` (slashes), so it misses this. Fix: one shared `pathSegment(id, label)` helper that throws PaymentReliabilityError INVALID_REQUEST for empty/whitespace, `.` or `..`, else returns encodeURIComponent(id); use it at every site; add tests for '', '.', '..'.
2. minor - paypal-subscription-executor.ts createSubscription: returnUrl/cancelUrl are passed unvalidated (no URL/length check). Pre-existing behaviour, not a regression; PayPal rejects bad values itself.
3. minor - subscription-lifecycle-service.ts handleFailure (~1133): failureMessage now comes from resolveProviderFailure (sanitised) instead of the raw err.message; intended for #14 and tests pass, but the stored message for plain Errors is now the sanitised one. Informational.

Checked and fine: #12 rules/allowZero (REGULAR zero rejected, TRIAL zero/absent accepted, "0" with currency), planOperationId plan-status check, test edits justified; #13 fields/enums/127 limit/NO_SHIPPING default/fingerprint order unchanged when unset; #14 debug id regex-limited, PaymentReliabilityError TRANSITION_REJECTED, no caller branches on message text, sha256Payload moved with re-export.
