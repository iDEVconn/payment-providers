---
"@idevconn/payment-providers": minor
---

Pure subscription core, a store conformance kit, and a reliability pass over the PayPal engine (issues #4, #6, #7, #8, #9, #10, #11, #12, #13, #14, #15, #16, #19, #20, #21, #22, #23, #24, #25).

**Highlights**

- New entry `@idevconn/payment-providers/subscription`: an IO-free PayPal event normaliser (`normalizePaypalSubscriptionEvent`, decimal amounts to integer minor units without floats, never throws) and a state reducer (`reduceSubscription`) with plain-data effects. Your service keeps its tables and business rules; the engine runs on the same functions.
- New entry `@idevconn/payment-providers/testing`: `runStoreConformance` checks a store implementation (idempotency, version compare-and-set, claims, transition history, provider-id uniqueness, patch semantics, evidence uniqueness, leases, candidate order, consumer-delivery fields, retry fields) with your own `describe`/`it`/`expect`.
- New entry `@idevconn/payment-providers/legacy` for the `@idevconn/payment` checkout surface; `@idevconn/payment` is now an optional peer dependency.
- `PaymentReliabilityStore` is split into capability interfaces (`OperationStore`, `EvidenceStore`, `ReconciliationStore`, `SubscriptionStore`, ...); the services run with a `SubscriptionStore` alone.
- The root entry now exports an explicit list of names; a test pins the list of every entry point.
- README rewritten: ownership split, pure core, end-to-end webhook route, production guards, retry and recovery, a Postgres schema and migration for a subscriptions-only host, upgrade notes, known limits.

**Breaking changes**

1. The root no longer exports `LegacyPaymentError` (value and type). Import it from `@idevconn/payment-providers/legacy`.
2. `/paypal` no longer exports `PaypalPaymentProvider`, `createPaypalPaymentProvider`, `invokeCheckoutWhenReady` and the type `CheckoutOperation`. They moved to `/legacy`.
3. `@idevconn/payment` is an optional peer dependency and is no longer installed with the package. Only `/legacy` needs it (it brings its own non-optional peer `express@^5`).

Type-level breaks: `VerifiedProcessedPaymentEvent` has a required `providerEventId`; `ConsumerDeliveryStatus` has a new `failed_terminal` value (exhaustive switches need a case); `PaymentReliabilityErrorCode` has new codes `WEBHOOK_PAYLOAD_MISMATCH`, `SUBSCRIPTION_STATE_UNREADABLE`, `SUBSCRIPTION_STATE_VERSION_UNSUPPORTED` and `SUBSCRIPTION_EFFECTS_HOOK_FAILED`.

**New required store columns and values**

- `subscriptionStateJson` on operations (nullable `text` or `jsonb`): last payment, failed-payment count, recent webhook and sale ids, held effects, reported plan mismatches. Read it with `readSubscriptionOperationState`.
- `attempts`, `nextAttemptAt` and `retryStatus` (nullable; the CHECK must allow `'gave_up'`) on operations and on evidence.
- `transitionKind` (`claim_execution` | `claim_retry`) on history rows; services no longer read the free-text `reason`.
- `consumerDeliveryStatus` accepts `'failed_terminal'`; a CHECK with three values rejects the write.
- `claimPendingEvidence` must honour `includeConsumerDelivery` and the new `includePendingVerification`; the three candidate lists return only due rows (`retry_status IS NULL`, `next_attempt_at` null or reached) ordered by `COALESCE(next_attempt_at, received_at | created_at)`; `listReconciliationCandidates` lists `webhook` evidence only; `listUncertainOperations(limit, options)` takes a second argument (stale `submitted` creates); optional `reviveUnmatchedEvidence`.
- Provider ids are unique per kind (partial unique indexes); `null` clears a field on update.

**New constructor parameters and options**

- `WebhookProcessingService(store, subscriptionLookup?, intakeOptions?, hooks?)`: intake `maxBodyBytes` (default 256 KiB), `maxTransmissionAgeMs` / `maxTransmissionFutureMs` (opt-in freshness), `requireTransmissionHeaders`; `hooks.onSubscriptionEffects`.
- `ReconciliationService(store, lookup, hooks?, options?)` and `PaymentRecoveryService`: `retryBaseDelayMs`, `retryMaxDelayMs`, `maxAttempts` (default 100), `submittedStaleAfterMs`, `maxConsumerDeliveryAttempts` (default 10), `includeRawPayload`.
- `SubscriptionLifecycleService(store, provider, hooks?)`.
- `ReceiveWebhookInput`: optional `providerEventId` (defaults to the body `id`) and optional `headers`.
- `buildPaypalWebhookVerifier`: `webhookId`, `requireWebhookId`. `resolvePaymentRuntime` and all six factories: `allowRejectOnlyInProduction`.
- `CreateSubscriptionRequest`: `customId`, `shippingPreference`, `brandName`, `userAction`, `productType`.

**New exports**

`adoptSubscriptionPlan`, `readSubscriptionOperationState`, `SubscriptionEffectsHook(s)`, `WebhookEventPayloadMismatchError`, `WebhookIntakeOptions` and its defaults, retry defaults (`DEFAULT_RETRY_*`, `MAX_RETRY_*`, `DEFAULT_SUBMITTED_STALE_AFTER_MS`), `RETRY_STATUS`, `OPERATION_TRANSITION_KIND`, `isProviderCallsKillSwitch`, `pathSegment`, the store capability interfaces, and from `/paypal` the shared 401 helpers `resendWithFreshPaypalTokenOn401` and `sendWithPaypalAccessToken`. Engine internals (`applySubscriptionEvents`, held-effect helpers, retry arithmetic) are deliberately not exported.

**Fixes**

- Subscription state (#4): plan mismatch is detected without a lookup and never grants access; sales are checked against the plan price; `PAYMENT.SALE.*` and `PAYMENT.FAILED` change state and produce effects; `UPDATED` is processed; next billing time, start time, last payment and failed count are stored; late `CREATED`/`APPROVED` events no longer move a subscription back; a sale resource id never overwrites the subscription id; an uncertain cancel, suspend or activate command reconciles to `succeeded` or `failed`.
- Webhooks and verification (#15, #19): the original raw event text is sent to PayPal; a 400/401/403/5xx or malformed verify answer is `verification_unavailable`, only `FAILURE` rejects; intake rejects missing headers, oversized bodies and event-id mismatches before storing; a known event id with another body is `WEBHOOK_PAYLOAD_MISMATCH`.
- OAuth and HTTP (#16): the token cache is keyed by `clientId`; a 401 evicts the token and resends once with a fresh one (single flight), a second 401 is `PROVIDER_AUTH_FAILURE`; live clients refuse redirects; tests for the fetch clients. A host token provider must honour `rejectedToken`.
- Production (#7): `resolvePaymentRuntime` and the factories throw `PaymentConfigurationError` instead of booting reject-only (opt out with `allowRejectOnlyInProduction`; the `providerCallsEnabled` kill switch keeps the verifier up and stores webhooks pending); a missing webhook id fails at build.
- Packaging (#9, #10, #11): CommonJS shares one copy of the core classes across entries; `typesVersions` for `moduleResolution: node10`; root, `/paypal` and `/subscription` do not load `@idevconn/payment`; declarations carry local structural legacy types; workflows use job-scoped permissions, `npm ci --ignore-scripts`, SHA-pinned actions and a separate publish job; vitest 4 clears `npm audit`.
- Store contract (#6, #21, #23, #24): capability interfaces and the conformance kit; typed claim kind; consumer delivery stops at `maxConsumerDeliveryAttempts` (`failed_terminal`) and gets a narrowed event; `recover()` without a consumer claims nothing and reports `delivered: 0`.
- Fair retry (#8, #20): reconciliation and recovery back off exponentially and give up after `maxAttempts`; foreign unmatched events no longer hide a matchable one; retry state is cleared when a row resolves.
- Create path (#12, #13, #14, #22, #25): REGULAR cycles need a positive price and TRIAL cycles come first; the plan-operation path checks plan status; `custom_id` and `application_context` pass through (`NO_SHIPPING` by default); the PayPal `debug_id` is kept; ids in URL paths are encoded and empty, `.` and `..` ids are rejected; overlapping create retries store one result; the idempotency fingerprint includes the subscriber email and every request-shaping field; a create that crashed after its claim is marked `unknown` after `submittedStaleAfterMs` so it can be retried.
