# T4 report: packaging and supply chain (#9, #10, #11)

Status: DONE. Nothing committed.

Results (before fix wave): lint, typecheck, build, test green: 93 files / 871 tests (baseline 91 / 857). `npm audit`: 0 vulnerabilities. `npm pack --dry-run`: 49 files (dist: index/paypal/legacy/subscription x js/cjs/d.ts/d.cts + maps + 6 shared chunks, README, LICENSE, package.json).

## Files changed by T4
.github/workflows/ci.yml, .github/workflows/release.yml, package.json, package-lock.json, tsup.config.ts, README.md,
src/legacy/index.ts (new), src/contracts/lib/legacy-checkout.ts, src/paypal/index.ts, src/paypal/lib/paypal-checkout-executor.ts,
test/dist-entry-identity.test.ts (new), test/entries-consumer.test.ts (new), test/environment-independence.test.ts, test/package-consumer.test.ts, test/public-exports.unit.test.ts.
(README edit is minimal: entry table row and the legacy imports; T7 owns the full docs.)

## #9
tsup `splitting: true` (CJS now shares chunks with ESM), so root, /paypal, /subscription use one copy of core classes. `test/dist-entry-identity.test.ts` spawns node on dist CJS and ESM and asserts `err instanceof core.PaymentCapabilityError` for an error thrown by `PaypalSubscriptionExecutor` (failed before the fix under CJS). `test/entries-consumer.test.ts` runs real `tsc` in a temp consumer under node10 and node16 for root, /paypal, /subscription, /legacy; verified it fails with TS2307 when typesVersions for paypal/legacy are removed. typesVersions for /paypal, /subscription, /legacy present.

## #10 (BREAKING, see below)
New entry `@idevconn/payment-providers/legacy` (`src/legacy/index.ts`): `LegacyPaymentError` (runtime), the legacy types, and `PaypalPaymentProvider`, `createPaypalPaymentProvider`, `invokeCheckoutWhenReady`, `CheckoutOperation` (these construct `PaypalStrategy` from @idevconn/payment at runtime). Root keeps the legacy types as type-only `@deprecated` re-exports. `PaypalCheckoutExecutor` used `instanceof PaymentError`; replaced by a structural check (`Error` with `name === 'PaymentError'`), so it stays in /paypal with type-only imports. `UnconfiguredFakeCheckoutStrategy` is type-only too and stays in /paypal.
`@idevconn/payment`: moved from `dependencies` to optional `peerDependencies` (`peerDependenciesMeta.optional`) and added to devDependencies.
Proof (spawned node, CJS resolve hook + `require.cache`, ESM resolve hook): root, /paypal, /subscription load none of axios, zod, express, @idevconn/payment; /legacy does load @idevconn/payment.

BREAKING for the changeset:
1. Root no longer exports runtime `LegacyPaymentError` (an ESM named export cannot be lazy). Use `@idevconn/payment-providers/legacy`.
2. `/paypal` no longer exports `PaypalPaymentProvider`, `createPaypalPaymentProvider`, `invokeCheckoutWhenReady`, `CheckoutOperation`. Moved to `/legacy`.
3. `@idevconn/payment` is no longer installed automatically; only `/legacy` needs it.

(Declaration concern fixed in the Fix wave below.)

## #11
- ci.yml: top-level `permissions: {}`, job `contents: read`, `persist-credentials: false`, `npm ci --ignore-scripts`, new "Package smoke tests" step (dist-package-surface, dist-entry-identity, entries-consumer, subscription-entry-consumer).
- release.yml: split into `verify` (contents: read; install, typecheck, build, test, smoke, lint, pack) and `release` (needs verify; the only job with contents: write, pull-requests: write, id-token: write). Publish steps (OIDC cleanup, npm@11.21.1, changesets action, provenance env, tag push, GitHub release) unchanged. `release` runs `npm run build` after install since `changeset publish` needs dist.
- Pinned by SHA (same majors as before, latest patch): actions/checkout 11d5960a326750d5838078e36cf38b85af677262 # v4.4.0; actions/setup-node 49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0; changesets/action a45c4d594aa4e2c509dc14a9f2b3b67ba3780d0d # v1.9.0 (annotated tag followed to commit).
- `npm ci --ignore-scripts` verified in a clean copy: build and 871 tests pass.
- vitest `^3.0.0` -> `^4.1.12` (lowest 4.x clearing GHSA @vitest/mocker and tinypool advisories; <=4.1.11 affected, 5.x not needed). Remaining low esbuild advisory (0.27.3-0.28.0, Windows dev server) cleared via `npm audit fix` (lock resolves esbuild 0.27.2). package-lock.json regenerated (the install downloaded packages from the registry; needed to verify the bump).

Rulings:
- Ruling: did a real `npm install` to bump vitest (tarball fetch, not just metadata), since the bump cannot be verified otherwise.
- Ruling: pinned same action majors to avoid behaviour changes rather than jumping to v7/v6.
- Ruling: release workflow split into two jobs to satisfy "publish job alone gets id-token".

## Fix wave: declarations free of @idevconn/payment
- `src/contracts/lib/legacy-checkout.ts` now holds local structural copies (same shapes as @idevconn/payment 1.2) of `CreateOrderInput`, `OrderResult`, `CaptureResult`, `RequestOptions`, `PaymentStrategy`, `PaymentErrorCode`, `PaymentError` (interface), all `@deprecated`. `PaymentStrategy` is a new root type export (additive). Paypal checkout executor, its factory and `UnconfiguredFakeCheckoutStrategy` import these local types. Real types stay only in `src/legacy/index.ts` and `paypal-payment-provider.ts` (/legacy).
- New `test/dist-declarations.test.ts`: copies dist into a temp consumer outside the repo (no @idevconn/payment resolvable), greps root/paypal/subscription `.d.ts` and `.d.cts` and every shared chunk reachable by relative import for the package name, and runs real `tsc` with `skipLibCheck: false` under node10 and node16. Failed first (TS2307 in index.d.ts and paypal.d.ts, plus missing PaymentStrategy), passes now. /legacy declarations still reference the real package (asserted).
- Result: lint, typecheck, build clean; 94 files / 877 tests green; `npm audit` 0 vulnerabilities.
- Delta files: src/contracts/lib/legacy-checkout.ts (rewritten), src/paypal/lib/paypal-checkout-executor.ts, src/paypal/lib/paypal-checkout-executor.factory.ts, src/paypal/lib/unconfigured-fake-checkout.strategy.ts, test/dist-declarations.test.ts (new).
- Commit message gains the line: "- declarations of root, /paypal and /subscription carry local structural legacy types; no @idevconn/payment reference".

Commit message:
```
build: fix CJS identity, split legacy entry, harden workflows

- tsup splitting so root, /paypal and /subscription share one core copy
- add ./legacy entry (LegacyPaymentError, PaypalPaymentProvider,
  createPaypalPaymentProvider); root/paypal/subscription no longer load
  @idevconn/payment, which becomes an optional peer dependency
- declarations of root, /paypal and /subscription use local structural
  legacy types and no longer reference @idevconn/payment
- CI: job-scoped permissions, npm ci --ignore-scripts, SHA-pinned actions,
  split release verify/publish jobs, package smoke tests
- bump vitest to ^4.1.12 and clear npm audit

BREAKING CHANGE: LegacyPaymentError and the PaypalPaymentProvider
checkout provider moved to @idevconn/payment-providers/legacy.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
```
