Suggested title: `feat: pure subscription core, store conformance kit and reliability fixes (0.3.0)`

## Summary

Owner decision "option C": provider knowledge lives in the package as pure, tested functions; persistence, queues, scheduling and product rules stay in the consumer.

- **Pure core** (`@idevconn/payment-providers/subscription`): `normalizePaypalSubscriptionEvent` (decimal amounts to minor units without floats, never throws) and `reduceSubscription` (status, ordering, plan, amount and currency rules, plain-data effects). The engine (`WebhookProcessingService`, `ReconciliationService`, the lifecycle commands) now runs on the same functions; the duplicated rules are gone.
- **Store contract**: `PaymentReliabilityStore` split into capability interfaces; a subscriptions-only host implements `SubscriptionStore`. New entry `/testing` with `runStoreConformance`.
- **Reliability fixes** across the PayPal adapter, verifier, OAuth, intake, retry queue and create path (see the `Fixes` lines).
- **Packaging**: `/legacy` entry, optional peer `@idevconn/payment`, CJS identity, `node10` types, hardened workflows, vitest 4 (audit clean), explicit root export list pinned by tests.
- README rewritten (ownership split, pure core, end-to-end webhook route, production guards, retry and recovery, Postgres schema and migration, upgrade notes, known limits). Changeset: `minor`.

## Breaking changes

1. The root no longer exports `LegacyPaymentError` (value and type): import it from `@idevconn/payment-providers/legacy`.
2. `/paypal` no longer exports `PaypalPaymentProvider`, `createPaypalPaymentProvider`, `invokeCheckoutWhenReady` and the type `CheckoutOperation`: moved to `/legacy`.
3. `@idevconn/payment` is an optional peer dependency (needed only for `/legacy`; it brings its own non-optional `express@^5` peer).

Type-level: `VerifiedProcessedPaymentEvent.providerEventId` is required, `ConsumerDeliveryStatus` gains `failed_terminal`, `PaymentReliabilityErrorCode` gains four codes. Every other 0.2.1 export is still exported (checked by building 0.2.1 and comparing runtime and declaration names of root and `/paypal`).

## Required host changes

- Store columns: `subscriptionStateJson` (text or jsonb) on operations; `attempts`, `nextAttemptAt`, `retryStatus` (CHECK allows `'gave_up'`) on operations and evidence; `transitionKind` on history rows; `consumerDeliveryStatus` accepts `'failed_terminal'`. SQL in the README.
- Store behaviour: honour `includeConsumerDelivery` and `includePendingVerification` in `claimPendingEvidence`; candidate lists return due rows ordered by `COALESCE(next_attempt_at, ...)`; `listUncertainOperations(limit, options)`; optional `reviveUnmatchedEvidence`. Run `runStoreConformance`.
- Constructors and options: `WebhookProcessingService(store, lookup?, intakeOptions?, hooks?)`, `ReconciliationService(store, lookup, hooks?, options?)`, `SubscriptionLifecycleService(store, provider, hooks?)`, `PaymentRecoveryService({ retry options, maxConsumerDeliveryAttempts, includeRawPayload })`, `buildPaypalWebhookVerifier({ webhookId, requireWebhookId })`, `allowRejectOnlyInProduction`, new `CreateSubscriptionRequest` fields.
- Webhook route: pass the five PayPal headers, the exact raw body, one `headers` object for intake and verify; set `webhookId`; a host token provider must honour `rejectedToken`.
- Alert on `retry_status = 'gave_up'`; configure reconciliation and recovery with the same retry options.

## Test plan

```bash
npm ci --ignore-scripts
npm run lint
npm run typecheck
npm run build
npm test            # 112 files / 1099 tests (main: 77 / 439)
npx vitest run test/dist-package-surface.test.ts test/dist-entry-identity.test.ts test/entries-consumer.test.ts test/subscription-entry-consumer.test.ts test/testing-entry-consumer.test.ts test/dist-declarations.test.ts test/dist-export-surface.test.ts   # 7 files / 42 tests
npm audit           # 0 vulnerabilities
npm pack --dry-run  # 67 files, 727.1 kB packed, 4.1 MB unpacked
```

Also done by hand, against a fresh build of the final tree: the README's Postgres schema and lease-claim query were run through `runStoreConformance` (41 of 41 cases, including the insert-time delivery-status case) with a throwaway `pg` store written for them on Postgres 16 (the store is not part of the PR; re-run it once more before merge if the kit or the SQL changes); the 0.2-to-0.3 migration was applied to a 0.2-shaped schema; the README's TypeScript examples were compiled against the built package under `moduleResolution: node16` before the last code wave and not recompiled since (the blocks did not change).

Fixes #4
Fixes #6
Fixes #7
Fixes #8
Fixes #9
Fixes #10
Fixes #11
Fixes #12
Fixes #13
Fixes #14
Fixes #15
Fixes #16
Fixes #19
Fixes #20
Fixes #21
Fixes #22
Fixes #23
Fixes #24
Fixes #25

## Known leftovers

- #16: every factory call creates its own OAuth client, and the OAuth base URL follows `credentials.environment`. Both fail closed and are harmless; build executors once and reuse them.
- Reconciliation takes no lease on evidence rows: two concurrent `reconcile()` workers can process one row twice and lose an `attempts` increment (the cap is reached a little later).
- The release workflow builds in the publish job (`changeset publish` needs `dist`). Suggested follow-up: build in `verify` and pass `dist` as an artifact, so the job holding `id-token: write` runs no devDependency code.
- `./legacy` types still reference the real `@idevconn/payment` declarations (root, `/paypal` and `/subscription` carry local structural copies).
- Evidence that 0.2.x stored as `rejected` after a verify answer of 400/401/403 stays rejected; hosts can reset those rows by hand.
- Same-second status conflicts: settled by the provider lookup (provider snapshot wins; webhook lookup branch and reconciliation). Without a lookup the evidence is `unmatched` with `SUBSCRIPTION_STATE_CONFLICT_EQUAL_TIMESTAMP` until `reconcile()` repairs it.
- `AGENTS.md` still describes the earlier extraction; it was not updated here.
