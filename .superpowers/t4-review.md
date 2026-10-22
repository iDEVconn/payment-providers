# T4 review

Verdict: APPROVED (minor notes only).

Observed: lint clean, typecheck clean, build ok, test 94 files / 877 tests passed (0 skipped, consumer/dist tests ran), npm audit 0 vulnerabilities, npm pack 49 files, no @idevconn/payment reference in root/paypal/subscription d.ts/d.cts or JS (only legacy.*).
Pinned SHAs verified with gh api: checkout v4.4.0 11d5960a..., setup-node v4.4.0 49933ea5..., changesets/action v1.9.0 a45c4d59... all match the commented tags. No unpinned `uses:`, no pull_request_target/workflow_run/github.event interpolation.
Export diff (old snap build vs current): removed = root LegacyPaymentError (runtime+type); /paypal PaypalPaymentProvider, createPaypalPaymentProvider, invokeCheckoutWhenReady, CheckoutOperation. Added root type PaymentStrategy. /subscription unchanged. Exactly the documented breaking items.
Lock: all 383 resolved entries on registry.npmjs.org, all with integrity.

Findings (all minor)
1. minor, .github/workflows/release.yml (release job, "Build" step + prepublishOnly): the publish job still executes devDependency code (tsup, vitest via prepublishOnly, changeset) with the OIDC env present; only install scripts are blocked. Inherent to building in the publish job; optional hardening: build in verify and hand dist over (needs upload-artifact, another pinned action).
2. minor, src/paypal/lib/paypal-checkout-executor.ts:495: name-based PaymentError check can match a foreign error named PaymentError, but rejectUnconfigured only ever awaits UnconfiguredFakeCheckoutStrategy (which rejects with plain objects), so the branch is effectively unreachable; old instanceof had the same reachability. No fix needed (optionally drop the branch).
3. minor, package.json peerDependencies: issue #10 asked to narrow/pin the range and document express: range stays ^1.2.0 and README does not say that installing @idevconn/payment pulls its non-optional express@^5 peer. Add one README sentence in T7.
4. minor (process), breaking change vs the global "additive" rule: allowed by the T4 plan if documented; T7 changeset must carry the 3 BREAKING items (package is 0.x: minor bump).
