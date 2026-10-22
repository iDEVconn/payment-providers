# @idevconn/payment-providers

Standalone npm library for **provider-neutral payment contracts**, **reusable payment lifecycle orchestration**, and **PayPal provider integration**. The module coordinates checkout, subscriptions, payouts, marketplace flows, seller onboarding, webhooks, reconciliation, and recovery while keeping **persistence and business projections behind consumer-implemented ports**.

You get:

- Shared payment contracts and operation/evidence models
- A **pure subscription core** (`/subscription`): PayPal event normalisation and a subscription state reducer with no IO, so your service keeps its own tables and business rules
- Lifecycle services that enforce idempotency, transitions, and claim/lease semantics
- `PaymentReliabilityStore` (split into capability interfaces) and `PaymentEventConsumer` ports (consumer-owned implementations), plus a **conformance kit** (`/testing`) that checks your store
- PayPal HTTP executors, OAuth (with a 401 retry), and webhook verification via `@idevconn/payment-providers/paypal`
- Webhook ingestion, duplicate handling, and incomplete-evidence resumption helpers
- `PaymentRecoveryService` and `ReconciliationService` with fair retry (backoff, `gave_up`) and consumer-delivery retries

The package does **not** load secrets, read `process.env`, or ship a database schema. Your backend supplies configuration, storage, HTTP endpoints, and admin/read APIs.

---

## Installation

Requires **Node.js `>=22.12.0`** (see `package.json` `engines`).

```bash
npm install @idevconn/payment-providers
```

`@idevconn/payment` is an **optional peer dependency**. Only `@idevconn/payment-providers/legacy` loads it; the root, `/paypal`, `/subscription` and `/testing` do not (a test loads each entry and checks that `axios`, `zod`, `express` and `@idevconn/payment` stay unloaded). Install it only if you import `/legacy`: `@idevconn/payment` has its own non-optional peer `express@^5`, so installing it also asks your project for `express@^5`.

### Entry points

| Import | Purpose |
|--------|---------|
| `@idevconn/payment-providers` | Contracts, lifecycle services, ports, webhook/recovery/reconciliation, runtime resolution, configuration types |
| `@idevconn/payment-providers/paypal` | PayPal provider composition, executors, OAuth, webhook verification, retry policies |
| `@idevconn/payment-providers/subscription` | Pure subscription core: PayPal event normalisation and the subscription state reducer (no IO; see [Pure core](#pure-core)) |
| `@idevconn/payment-providers/testing` | Store conformance kit `runStoreConformance` for host store implementations (no test-runner dependency; see [Implementing a store](#implementing-a-store)) |
| `@idevconn/payment-providers/legacy` | Legacy `@idevconn/payment` checkout surface: `createPaypalPaymentProvider`, `PaypalPaymentProvider`, `invokeCheckoutWhenReady`, `LegacyPaymentError`. The only entry that loads `@idevconn/payment`, an optional peer dependency |

All five work under ESM, CommonJS and TypeScript `moduleResolution` `node10` and `node16` (both type-checked by a test with a real `tsc` against the built package). The root, `/paypal` and `/subscription` share one copy of the core classes in CommonJS, so `instanceof PaymentCapabilityError` works across entries.

```ts
import {
  resolvePaymentRuntime,
  CheckoutLifecycleService,
  WebhookProcessingService,
  PaymentRecoveryService,
  type PaymentProviderConfig,
  type PaymentReliabilityStore,
  type PaymentEventConsumer,
} from '@idevconn/payment-providers';

import {
  buildPaypalCheckoutExecutor,
  buildPaypalWebhookVerifier,
} from '@idevconn/payment-providers/paypal';
import { createPaypalPaymentProvider } from '@idevconn/payment-providers/legacy';
```

Types such as `PaymentProviderConfig` are exported for TypeScript; use `import type` where appropriate. The root exports an **explicit** list of names (the engine's internal helpers are not part of it); a test pins the list per entry point.

---

## Which side owns what

**In the package (provider knowledge):** the PayPal protocol (REST calls, OAuth with a single resend after a 401, webhook signature verification over the original body), event normalisation, the subscription status, ordering, plan, amount and currency rules (the pure core, one source of truth for the engine and for you), idempotency fingerprints, claim and lease semantics, state machines, retry backoff.

**In your service (persistence, scheduling and product rules):**

| You own | How the package reaches it |
|---------|----------------------------|
| Tables, transactions, row versions | `PaymentReliabilityStore` capability interfaces, checked by the conformance kit; or your own tables around the pure core |
| Queues, cron, worker processes | You call `ReconciliationService.reconcile` and `PaymentRecoveryService.recover` on your schedule |
| Product rules: plan mapping, entitlements, paid-through dates, downgrade timing, credits, proration | `onSubscriptionEffects` hook and `PaymentEventConsumer.deliver` get plain data; the package puts no business logic there |
| HTTP route, raw body, auth, secrets, alerts | Your composition root passes explicit `PaymentProviderConfig` |

Two ways to integrate, and you can mix them: **(1)** keep your own subscription table and use only the pure core (`/subscription`): normalise, dedupe, reduce, store; **(2)** run the engine (`WebhookProcessingService`, `ReconciliationService`, `PaymentRecoveryService`, `SubscriptionLifecycleService`) on a store you implement.

---
## Pure core

`@idevconn/payment-providers/subscription` holds the provider knowledge for subscriptions as pure functions:
no IO, no clock, no randomness, no persistence. Time and ids come in as arguments. It works under ESM, CJS
and TypeScript `moduleResolution: node10`, and it does not load the engine or the legacy checkout runtime.

The contract:

1. The host persists a `SubscriptionState` per subscription (`status`, `providerSubscriptionId`,
   `providerPlanId`, `stateAt` watermark, `nextBillingTime`, `startTime`, `lastPayment`,
   `failedPaymentsCount`, `lastEventId`, `recentEventIds`, `recentSaleIds`). Start from
   `initialSubscriptionState()`; the subscription id is learned from the first event.
2. For each verified webhook it calls `normalizePaypalSubscriptionEvent(rawBody)`. This never throws: invalid
   JSON, a wrong shape, an unsupported event type or a sale that is not tied to a subscription gives
   `{ ok: false, reason }`. Amounts become integer minor units (decimal strings) with string arithmetic and
   ISO 4217 exponents (JPY/KRW 0, BHD/KWD/JOD/OMR/TND 3, default 2).
3. It calls `reduceSubscription(state, event, { source, expectedPlanId?, expectedPayment? })` and gets
   `{ state, decision: 'applied' | 'noop', reason?, effects }`. It stores `state` (always a fresh copy that
   shares no objects with the inputs; a noop returns a copy equal to the input) and treats `effects` as its own business hooks: `status_changed`, `payment_completed`,
   `payment_failed`, `plan_mismatch`, `amount_mismatch`, `currency_mismatch`, `refund_or_reversal`,
   `period_updated`. A provider `GET` subscription body goes through `normalizePaypalSubscriptionResource`
   and `source: 'lookup'`.

Rules (the engine uses the same functions):

- `cancelled` and `expired` are terminal; `approved`, `active` and `suspended` never move back to
  `approval_pending` (a late `CREATED`), and `active`/`suspended` never move back to `approved` (a late
  `APPROVED`). Timestamps must be real ISO 8601 instants with a zone; impossible dates (Feb 30, 24:00) count
  as missing.
- Webhooks: an older `stateAt` is a noop (`stale`), an equal `stateAt` with another status is a noop
  (`equal_conflict`), and a missing `stateAt` after a watermark is a noop (`missing_timestamp`). A lookup
  is authoritative over ordering but still bound by the terminal and regression rules.
- Plan check: `expectedPlanId` defaults to the stored `providerPlanId`. An event `plan_id` that differs
  reports `plan_mismatch`. It blocks the event only when the result would be `approved` or `active` (access
  is never granted or kept on an unexpected plan); a suspension, cancellation, expiry or failed payment still
  applies, so a revised or drifted plan can always lose access. A mismatching plan is never stored: after a
  PayPal plan revision the host passes the new plan as `expectedPlanId` to adopt it.
- `PAYMENT.SALE.COMPLETED` in another currency than `expectedPayment`, below it, or with an amount that
  cannot be read is not applied and reports `currency_mismatch` / `amount_mismatch`. A higher amount is
  accepted. Payment events never change the status or the watermark.
- `BILLING.SUBSCRIPTION.PAYMENT.FAILED` reports `payment_failed` and takes `failed_payments_count` from the
  resource, or increments the stored counter. The counter never decreases, except when the provider resets it:
  an `ACTIVATED`/`RE-ACTIVATED` event, or a resource whose last payment is newer than the stored one.
- Refund and reversal totals keep their sign (`"-10.00"` is `"-1000"`); a negative completed sale is unreadable.
- **Dedupe is the host's job and is required.** PayPal redelivers events for days and in any order, so the
  host MUST drop a webhook whose `providerEventId` it already processed, and a `payment_completed` whose
  `saleId` it already recorded, BEFORE calling `reduceSubscription` (a unique key on
  `(provider, account, environment, event id)` and on the sale id). The reducer has a bounded safety net only:
  a webhook id among the last 16 applied ids, or a completed sale id among the last 16, is a
  `duplicate_event` noop. Mismatch noops are not remembered, so their effects repeat on redelivery.

```ts
import {
  initialSubscriptionState,
  normalizePaypalSubscriptionEvent,
  reduceSubscription,
} from '@idevconn/payment-providers/subscription';

const normalized = normalizePaypalSubscriptionEvent(rawBody); // after signature verification
if (normalized.ok) {
  const { providerEventId, eventType, payment } = normalized.event;
  // Required: unique inserts (in the same transaction as the save below) drop redeliveries.
  if (!(await db.insertProcessedEvent(providerEventId))) return;
  if (eventType === 'PAYMENT.SALE.COMPLETED' && payment?.saleId && !(await db.insertRecordedSale(payment.saleId))) return;
  const stored = (await db.loadSubscription(normalized.event.providerSubscriptionId)) ?? initialSubscriptionState();
  const result = reduceSubscription(stored, normalized.event, {
    source: 'webhook',
    expectedPayment: { amountMinor: '999', currency: 'USD' }, // from your plan catalogue
  });
  await db.saveSubscription(result.state); // compare-and-set on your row version
  for (const effect of result.effects) await onSubscriptionEffect(effect); // your product rules
}
```

Also exported: `deriveProviderEventId(rawBody)`, `isFreshTransmission(transmissionTime, now, maxSkewMs)`,
`parseDecimalToMinorUnits`, `currencyMinorUnitExponent`, and the status mapping and ordering helpers.

---

## Architecture overview

```text
Consumer backend
      |
      v
Application facade  (your routes, auth, config loading)
      |
      v
@idevconn/payment-providers
      |
      +--> PaymentReliabilityStore  (consumer persistence)
      +--> PaymentEventConsumer     (consumer business projection)
      +--> PayPal provider          (executors + verification)
```

**Command path** — mutations and provider calls:

```text
Consumer API → application facade → lifecycle service → provider port → PayPal HTTP
```

**Read path** — listings, admin screens, reporting:

```text
Consumer UI / Admin → your query API → your database (not this package)
```

Lifecycle command behavior lives in the module. **Admin/read APIs and seller CRM-style projections are consumer-owned.**

---

## Capability matrix

Statuses: **Implemented** (module + PayPal today), **Implemented through a port** (module orchestrates; you implement storage), **Consumer-owned** (outside package scope), **Not yet implemented** (no provider in this package).

| Area | Module support | Provider support (PayPal) | Consumer responsibility |
|------|----------------|---------------------------|-------------------------|
| Checkout (create / capture / get) | Implemented | Implemented (`CheckoutProviderPort`, `PaypalCheckoutExecutor`) | Store, idempotency keys, HTTP API |
| Subscription (product, plan, lifecycle) | Implemented, plus the pure core | Implemented (`SubscriptionProviderPort`, `PaypalSubscriptionExecutor`) | Store, billing projections, product rules |
| Payout batches | Implemented | Implemented (`PayoutProviderPort`, `PaypalPayoutExecutor`) | Store, sender identity policy |
| Refund (capture) | Implemented | Implemented via checkout executor | Store, refund idempotency |
| Marketplace checkout / capture / unit refund | Implemented | Implemented (`MarketplaceProviderPort`, `PaypalMarketplaceExecutor`) | Seller readiness data in store |
| Seller onboarding | Implemented | Implemented (`SellerOnboardingProviderPort`, `PaypalSellerOnboardingExecutor`) | Seller connection records in store |
| Webhook verification | Implemented | Implemented (`PaypalWebhookVerifier`, `buildPaypalWebhookVerifier`) | HTTP route, raw body, headers, webhook id |
| Webhook duplicate handling | Implemented | N/A | Optional `providerEventId` (defaults to the body `id`) |
| Incomplete webhook resumption | Implemented (`classifyWebhookEvidenceResume`, `WebhookProcessingService`) | N/A | Durable evidence rows |
| Reconciliation | Implemented (`ReconciliationService`) | Lookup via `ReconciliationProviderLookup` | When/how to run reconciliation jobs |
| Recovery | Implemented (`PaymentRecoveryService`, `isRecoverableEvidenceRow`) | Re-verify not applied to `pending` verification | Worker scheduling, `workerId`, leases |
| Claim / lease (evidence recovery, checkout create execution) | Implemented through a port | N/A | Atomic claim semantics in store |
| Consumer delivery | Implemented (`PaymentEventConsumer`, delivery fields on evidence) | N/A | Implement `deliver`; wire recovery |
| Sandbox / live selection | Implemented (`PaymentProviderConfig.environment`) | Implemented | Separate credentials per environment |
| Legacy `@idevconn/payment` checkout strategy | Implemented (`createPaypalPaymentProvider`, `@idevconn/payment-providers/legacy`) | Implemented | Optional compatibility layer; needs the optional peer `@idevconn/payment` |

**Other providers:** Only **PayPal** is implemented in this repository. Additional providers would require new adapter packages implementing the same port shapes.

---

## Providers

### PayPal (`@idevconn/payment-providers/paypal`)

PayPal is the only production provider adapter included today.

**Composition and runtime** (the two checkout-strategy items below are exported from `@idevconn/payment-providers/legacy`, not `/paypal`)

- `createPaypalPaymentProvider` — builds `PaypalPaymentProvider` from explicit `PaymentProviderConfig` (uses `resolvePaymentRuntime` internally)
- `PaypalPaymentProvider` — capability descriptor, `createCheckoutStrategy()` for `@idevconn/payment` `PaymentStrategy` compatibility (also `invokeCheckoutWhenReady`)

**Executors** (typically constructed with `ResolvedPaymentRuntime` from `resolvePaymentRuntime`):

- `buildPaypalCheckoutExecutor` → `PaypalCheckoutExecutor`
- `buildPaypalSubscriptionExecutor` → `PaypalSubscriptionExecutor`
- `buildPaypalPayoutExecutor` → `PaypalPayoutExecutor`
- `buildPaypalSellerOnboardingExecutor` → `PaypalSellerOnboardingExecutor`
- `buildPaypalMarketplaceExecutor` → `PaypalMarketplaceExecutor`

**Webhooks and HTTP**

- `buildPaypalWebhookVerifier` → `PaypalWebhookVerifier`
- `PaypalOAuthClient`, `resendWithFreshPaypalTokenOn401` / `sendWithPaypalAccessToken` (the shared 401 resend), live/fake HTTP clients for orders, subscriptions, payouts, seller onboarding
- `paypal-checkout-create-retry-policy`, `paypal-subscription-create-retry-policy`

**Safety / simulation**

- `UnconfiguredFakeCheckoutStrategy`, fake clients, `blockedHttpClient` / execution-mode guards (see tests and `PaymentExecutionStatus`)

Wire executors into core **lifecycle services** (`CheckoutLifecycleService`, `SubscriptionLifecycleService`, etc.) via the matching **provider port** interfaces.

### Other providers

No Stripe, Adyen, or other adapters are shipped. Integrate another PSP by implementing the port contracts and lifecycle expectations documented in `AGENTS.md`.

---

## Configuration

All runtime configuration is **explicit**. Pass a `PaymentProviderConfig` object from your composition root.

```ts
import type { PaymentProviderConfig } from '@idevconn/payment-providers';

const config: PaymentProviderConfig = {
  providerCode: 'paypal',           // optional; defaults to paypal
  accountRef: 'default',            // optional; logical account partition
  applicationRef: 'my-app',         // required — tenant / product identifier
  environment: 'sandbox',           // 'sandbox' | 'live'
  credentials: {
    clientId: process.env.PAYPAL_CLIENT_ID!,      // load in YOUR app only
    clientSecret: process.env.PAYPAL_CLIENT_SECRET!,
    webhookId: process.env.PAYPAL_WEBHOOK_ID,
    requestTimeoutMs: 30_000,
  },
  capabilityFlags: {
    checkout: true,
    refund: true,
    payout: true,
    subscription: true,
    seller_onboarding: true,
    marketplace_checkout: true,
  },
  partner: {
    merchantId: 'PARTNER_MERCHANT_ID',
    attributionId: 'bn-code',
    sellerOnboardingReturnUrl: 'https://example.com/seller/return',
    sellerOnboardingProducts: ['EXPRESS_CHECKOUT'],
    sellerOnboardingFeatures: ['PAYMENT', 'REFUND'],
  },
  marketplaceSellerReadinessMaxAgeMs: 300_000,
};
```

| Field | Role |
|-------|------|
| `environment` | Isolates sandbox vs live provider API bases and stored rows |
| `applicationRef` | **Required.** Scopes operations and evidence; no default is applied in production paths |
| `credentials` | PayPal REST and webhook verification secrets — **server-side only** |
| `capabilityFlags` | Gates which capabilities are considered enabled for readiness evaluation |
| `partner` | PayPal partner / marketplace seller onboarding attributes |
| `marketplaceSellerReadinessMaxAgeMs` | Freshness policy for seller readiness when marketplace is enabled |

**Security rules**

- The **consumer backend** loads and validates secrets.
- This module **does not** read `.env` or `process.env`.
- Never expose PayPal `clientSecret` or webhook signing material to browsers or public clients.
- Keep sandbox and live credentials and stored rows strictly separated.

Missing credentials in non-production may resolve to a **fake** runtime (`resolvePaymentRuntime`); production composition should fail fast via `PaymentConfigurationError` when configuration is invalid.

Optional `PaymentExecutionStatus` (passed to `createPaypalPaymentProvider` / executor factories) controls simulated execution and provider network kill-switch behavior for tests and controlled environments.

### Production guards

Pass `nodeEnv: process.env.NODE_ENV` (your code reads it; the package does not) to `resolvePaymentRuntime` and to every factory. With `nodeEnv === 'production'` a misconfigured deployment must not boot "healthy":

- `resolvePaymentRuntime` throws `PaymentConfigurationError` (names of the missing settings only, never values) when `executionStatus` is unconfigured, in simulation mode, or has provider calls turned off (except the kill switch below), and when credentials (`credentials.clientId`, `credentials.clientSecret`) are missing and the checkout capability is enabled or an `executionStatus` was passed: a configured `executionStatus` with checkout disabled does not excuse missing credentials. Forbidden or conflicting execution modes throw in production and for a `live` deployment environment.
- The six factories (`buildPaypalCheckoutExecutor`, `buildPaypalSubscriptionExecutor`, `buildPaypalPayoutExecutor`, `buildPaypalSellerOnboardingExecutor`, `buildPaypalMarketplaceExecutor`, `buildPaypalWebhookVerifier`) throw in production whenever they would build a blocked (reject-only) client.
- **`allowRejectOnlyInProduction: true`** (on `resolvePaymentRuntime` and on all six factory inputs) opts a deployment into the reject-only composition on purpose, for example a service that intentionally runs without payments. Forbidden and conflicting modes still throw.
- **Kill switch:** an `executionStatus` with `runtimeState: 'configured'`, an `executionMode` other than `'simulation'` and `providerCallsEnabled: false` is the documented, temporary switch that stops PayPal traffic. `resolvePaymentRuntime` and `buildPaypalWebhookVerifier` accept it in production without `allowRejectOnlyInProduction` (`isProviderCallsKillSwitch(status)` tells you whether a status is one): PayPal calls are rejected, and webhooks that arrive meanwhile are stored `pending` with `VERIFICATION_UNAVAILABLE` and are verified by a PayPal redelivery once the switch is lifted (recovery never verifies a `pending` row). The five executor factories still throw on a kill switch unless you pass `allowRejectOnlyInProduction`.
- `buildPaypalWebhookVerifier` takes `webhookId` and `requireWebhookId`. In production `requireWebhookId` defaults to true when the verifier would really call PayPal, so a missing `PAYPAL_WEBHOOK_ID` fails at start-up and not on every request. A kill-switch or reject-only verifier needs none. A `webhookId` on a `verify` request wins over the one given at build time.
- Not production: missing credentials still resolve to a fake runtime with a banner; the `forceFake` / `forceFakeHttp` options are refused in production.

Every live HTTP client refuses redirects (`redirect: 'error'`), and thrown errors never contain tokens, client secrets or redirect targets.

### Access tokens: the 401 resend

Every PayPal call made by the five executors and by the verify client goes through one helper: on HTTP 401 the token is reported as rejected, evicted from the cache (concurrent callers share one refresh), and the call is sent **once more** with a fresh token and the same `PayPal-Request-Id`. A second 401 is `PROVIDER_AUTH_FAILURE` (the verify client answers `verification_unavailable` instead). The OAuth cache key includes the `clientId`.

The factories wire this for you. If you build an executor yourself with your own token provider (`PaypalCheckoutTokenProvider` / `PaypalAccessTokenProvider`), the provider **must honour `options.rejectedToken`**: when it is passed, return a fresh token and do not hand out the cached one again. A provider that keeps returning the rejected token turns every revoked token into a `PROVIDER_AUTH_FAILURE`.

```ts
import type { PaypalAccessTokenProvider } from '@idevconn/payment-providers/paypal';

const tokenProvider: PaypalAccessTokenProvider = async (scope, options) => {
  if (options?.rejectedToken !== undefined) {
    await cache.evictIfEquals(scope, options.rejectedToken);
  }
  return cache.getOrFetch(scope); // a fresh token after an eviction
};
```

---

## Quick-start integration

Minimal sketch — **consumer-owned** pieces marked.

```ts
import {
  resolvePaymentRuntime,
  CheckoutLifecycleService,
  WebhookProcessingService,
  PaymentRecoveryService,
  type PaymentProviderConfig,
  type PaymentReliabilityStore,
  type PaymentEventConsumer,
} from '@idevconn/payment-providers';
import {
  buildPaypalCheckoutExecutor,
  buildPaypalWebhookVerifier,
} from '@idevconn/payment-providers/paypal';
// Needs the optional peer @idevconn/payment: only for the legacy checkout strategy.
import { createPaypalPaymentProvider } from '@idevconn/payment-providers/legacy';

// --- consumer-owned: load secrets and build config ---
const config: PaymentProviderConfig = {
  applicationRef: 'my-app',
  environment: 'sandbox',
  credentials: { clientId: '...', clientSecret: '...', webhookId: '...' },
};

const runtime = resolvePaymentRuntime({ config, nodeEnv: process.env.NODE_ENV });

const paypalProvider = createPaypalPaymentProvider({ config, nodeEnv: process.env.NODE_ENV });
const checkoutExecutor = buildPaypalCheckoutExecutor({
  runtime,
  strategyFactory: () => paypalProvider.createCheckoutStrategy(),
  nodeEnv: process.env.NODE_ENV,
});

// --- consumer-owned: durable PaymentReliabilityStore ---
const store: PaymentReliabilityStore = myPaymentStoreImplementation;

const checkout = new CheckoutLifecycleService(store, checkoutExecutor);

// --- consumer-owned: idempotent business projection ---
const consumer: PaymentEventConsumer = {
  async deliver(event) {
    // project verified, processed webhook outcomes into your domain
  },
};

const webhooks = new WebhookProcessingService(store /*, optional subscription lookup, intake options, hooks */);

const verifier = buildPaypalWebhookVerifier({
  runtime,
  nodeEnv: process.env.NODE_ENV,
  webhookId: config.credentials?.webhookId, // required in production
});

const recovery = new PaymentRecoveryService({
  store,
  webhookProcessing: webhooks,
  consumer,
});

// Example: create checkout order (module API — see contracts for request shapes)
// await checkout.createCheckoutOrder({ ... });

// Example: HTTP webhook handler (consumer-owned transport): see "Webhook flow" below for the full route,
// with headers, raw body and the intake options.

// Example: background recovery worker (consumer-owned scheduler)
// await recovery.recover({ workerId: 'worker-1', environment: 'sandbox', limit: 25 });
```

Replace placeholders with your storage, routing, and authorization. See `AGENTS.md` in the repository for exhaustive request/response shapes and store method contracts.

---

## Core consumer interfaces

### Implementing a store

**Purpose:** Durable payment operations, provider evidence, seller connections, marketplace units, reconciliation attempts, and claim/lease fields. **You implement** the store against your database (Postgres, etc.).

The contract is split by capability; implement only what your flows use. `PaymentReliabilityStore` stays the union of all of them.

| Interface | Methods for | Needed by |
|-----------|-------------|-----------|
| `OperationStore` | create (idempotent), find by id / idempotency / provider reference, claim, update, transition, transition history | every lifecycle service |
| `CreateExecutionLeaseStore` | `acquireCheckoutCreateExecutionLease` | subscription and checkout creates |
| `SubscriptionOperationLookupStore` | product, plan and subscription id lookups | subscriptions |
| `EvidenceStore` | insert / find / update evidence, `claimPendingEvidence` | webhooks, recovery |
| `ReconciliationStore` | `listReconciliationCandidates`, `listUncertainOperations`, `insertReconciliationAttempt` | `ReconciliationService` |
| `SubscriptionStore` | all five above | a subscriptions-only host |
| `CheckoutStore`, `PayoutStore`, `SellerStore`, `MarketplaceStore`, `EvidenceAdminStore` | the other flows | checkout, payouts, seller onboarding, marketplace, admin listing |

`SubscriptionLifecycleService`, `WebhookProcessingService`, `ReconciliationService` and `PaymentRecoveryService` run with a `SubscriptionStore`. They detect the other capabilities by their methods: a webhook of another family (checkout, payout, seller, marketplace) is stored as `unsupported`, seller connections are not reconciled, and an operation of a missing family gets a `no_op` reconciliation attempt with result code `STORE_CAPABILITY_NOT_CONFIGURED`.

A family counts as present only with **all** of its methods and as absent with **none**. A store with some of a family's methods (a typo, a forgotten method) makes `WebhookProcessingService` and `ReconciliationService` throw `PaymentConfigurationError` naming the family and the missing methods, at construction (or when the event arrives, if the store object changed later). Implement only the families you use and **delete stub methods** that throw: a throwing stub counts as present, so every event of that family keeps failing instead of being recorded as `unsupported`.

Guarantees every store must give (JSDoc on each interface has the details and error codes):

- **Errors:** throw `PaymentReliabilityError` with the documented codes; services branch on `code`.
- **Idempotency:** `UNIQUE(idempotency_scope, idempotency_key)`; the same key with an equal `commandFingerprint` returns the existing row, a different fingerprint throws `IDEMPOTENCY_CONFLICT`.
- **Optimistic concurrency:** every operation write is a compare-and-set on `version` (`WHERE version = $expected`, then `version + 1`); a mismatch changes nothing.
- **Claim:** `claimOperationForExecution` moves `prepared -> submitted` for exactly one of concurrent callers (`OPERATION_CONFLICT` for the others) and records `transitionKind: 'claim_execution'`. A create execution lease records `claim_execution` from `prepared` and `claim_retry` otherwise. Services read `transitionKind`, never the free-text `reason`; for history rows without it they use the structural `prepared -> submitted` move.
- **Transition + history:** the status change and its single history row (`reason`, `evidenceId`, `transitionKind`) are one transaction; a rejected transition writes nothing.
- **Provider ids:** `providerReferenceId` is unique across kinds; `providerSubscriptionId` among `subscription` operations, `providerPlanId` among `billing_plan`, `providerProductId` among `catalog_product`, `providerReferralId` among `seller_referral`, each per `(providerCode, accountRef, environment)` (partial unique indexes). Binding an id held by another operation throws `TRANSITION_REJECTED` (`provider_reference_bound`). Checkout and payout ids are not unique.
- **Patch semantics:** `undefined` keeps a field, `null` clears it (including `failureCode`/`failureMessage`). One exception: `transitionOperation` keeps `providerReferenceId` for `null`.
- **Evidence:** `UNIQUE(provider_code, account_ref, environment, provider_event_id)`; a duplicate throws `EVIDENCE_DUPLICATE`. `updateEvidence` has no version check (the recovery lease serialises writers).
- **Recovery lease:** `claimPendingEvidence` never gives one row to two workers while its lease is unexpired (`FOR UPDATE SKIP LOCKED`, or a conditional per-row update that may return fewer rows than `limit` under contention) and returns rows in the retry order below. In Postgres `UPDATE ... RETURNING` does not keep the subquery's `ORDER BY`: sort the returned rows (CTE plus an outer `ORDER BY COALESCE(next_attempt_at, received_at), evidence_id`).
- **`includeConsumerDelivery: false` is required:** recovery passes it when no consumer is configured, and the store must then skip rows that only await consumer delivery. A store that ignores it is not harmless: those rows are the oldest, so they fill every batch, get counted as `skipped`, and newer verified rows are never processed.
- **`includePendingVerification: false` is required:** recovery always passes it; the store skips rows whose verification is `pending` (only a provider redelivery with its headers can verify them, so recovery would only skip them).
- **Retry columns and order (issues #8, #20):** operations and evidence get three nullable columns, `attempts` (integer), `next_attempt_at` (timestamp) and `retry_status` (text, `null` or `'gave_up'`; a CHECK constraint must allow `'gave_up'`). `updateOperation` and `updateEvidence` store them with the usual patch semantics. `listReconciliationCandidates`, `listUncertainOperations` and `claimPendingEvidence` return only rows with `retry_status IS NULL` and `next_attempt_at IS NULL OR next_attempt_at <= now()`, ordered by `COALESCE(next_attempt_at, received_at)` (evidence) or `COALESCE(next_attempt_at, created_at)` (operations), then the id: a deferred row queues up again at its due time instead of in front of newer rows. `claimPendingEvidence` with `evidenceIds` ignores `next_attempt_at` (an explicit request) but never returns a row that gave up, except a row whose only remaining work is consumer delivery (that has its own cap). `listReconciliationCandidates` lists only `webhook` evidence: reconciliation's own rows belong to an operation that `listUncertainOperations` lists. Suggested indexes: `(next_attempt_at)` partial on `retry_status IS NULL` for both tables. Optional `reviveUnmatchedEvidence({ providerCode, accountRef, environment, resourceId })`: clear the three columns of verified `unmatched` `webhook` evidence with that `resource_id` and return the count; the lifecycle service calls it when a create binds a PayPal subscription id, so events that arrived before their operation are reconciled at once (without it they wait for their own backoff, and a row that gave up waits for a reset).
- **Stale `submitted` creates (issue #12):** `listUncertainOperations(limit, { submittedStaleBefore, submittedStaleKinds })` also returns `submitted` operations of those kinds (default `subscription`, `checkout`) without `provider_reference_id` whose `updated_at <= submittedStaleBefore` and whose execution lease is missing or expired. A store that keeps the 0.2 signature never lists them, so a create that crashed after its claim stays `submitted`.
- **Consumer-delivery fields:** persist and return `consumerDeliveryStatus`, `consumerDeliveredAt`, `consumerDeliveryAttempts` and `consumerDeliveryLastError` as written. A row read back without `consumerDeliveryStatus` counts as delivered, so a store that drops these columns silently skips every consumer delivery.
- **Subscription state column:** persist `subscriptionStateJson` (one nullable `text` or `jsonb` column, e.g. `subscription_state_json`) on `createOperation`, `updateOperation` and `transitionOperation`, with the same patch semantics, and return it on every read. The engine writes JSON text; a `jsonb` column may return it reformatted or as the parsed object (both are read; the kit compares the parsed content). The engine keeps the subscription reducer state there that has no column of its own: last payment, failed-payment count, recent webhook and sale ids (redelivery dedupe), effects not yet accepted by the host hook and plan mismatches already reported. Read it with `readSubscriptionOperationState(operation)`, never parse it yourself. A store that drops it loses the payment data and re-delivers effects; rows without it (written before 0.3) read as "no state yet". Unreadable content (`SUBSCRIPTION_STATE_UNREADABLE`) or a layout written by a newer package version (`SUBSCRIPTION_STATE_VERSION_UNSUPPORTED`, for example after a rollback) fails closed: nothing is applied or rewritten, the evidence stays `pending` with that code. Unknown fields of the supported version are kept on rewrite.

Run the conformance kit against your store in your own test suite. It takes your runner's `describe`, `it` and `expect` (vitest and jest fit) and needs a fresh, empty store per case:

```ts
import { describe, expect, it } from 'vitest';
import { runStoreConformance } from '@idevconn/payment-providers/testing';

runStoreConformance({
  createStore: async () => createPostgresStoreOnEmptySchema(),
  destroyStore: async (store) => store.close(),
  describe,
  it,
  expect,
  capabilities: { checkout: false, payout: false, seller: false, marketplace: false },
});
```

The engine computes `nextAttemptAt` with the service clock and the store compares it with its own clock; a skew of a few seconds only shifts a retry by that much.

**Retry backoff and giving up.** `ReconciliationService` (fourth constructor argument) and `PaymentRecoveryService` (dependencies) take `retryBaseDelayMs` (default 60000), `retryMaxDelayMs` (default 3600000, at most 7 days) and `maxAttempts` (default 100, at most 1000000); `ReconciliationService` also `submittedStaleAfterMs` (default 300000). Invalid values throw `PaymentConfigurationError` at construction. **Give both services the same retry options:** recovery and reconciliation share one `attempts`/`nextAttemptAt` on `unmatched` evidence, so with different options the smaller cap wins and one service's deferral also holds back the other. A candidate that is still unresolved after its attempt (an `unknown` operation whose lookup failed, `unmatched` evidence, a row that stays `pending` such as `SUBSCRIPTION_PLAN_MISMATCH`, `HELD_EFFECTS_OVERFLOW` or `SUBSCRIPTION_EFFECTS_HOOK_MISSING`) gets `attempts + 1` and `nextAttemptAt = now + min(retryMaxDelayMs, retryBaseDelayMs * 2^(attempts - 1))`; after `maxAttempts` it gets `retryStatus: 'gave_up'`. With the defaults (1, 2, 4, 8, 16, 32 min, then hourly) that is about 94 h after the first failure, longer than the redelivery window of about 3 days that PayPal's documentation describes (not observed here). A row that gave up keeps its status (`unknown`, `unmatched`, `pending`) and its data, but **nothing processes it any more** until a host resets it: alert on `retry_status = 'gave_up'`, fix the cause, and reset the row with `retry_status = NULL, attempts = NULL, next_attempt_at = NULL` (the next run picks it up). Exceptions: a PayPal redelivery of the same event is still processed, and a create that binds the subscription id revives its `unmatched` events (`reviveUnmatchedEvidence`). When a row resolves (evidence `processed`, an operation no longer uncertain) the engine clears the three columns, so a later uncertain episode starts a fresh schedule. A failed consumer delivery is deferred the same way but keeps its own cap (`maxConsumerDeliveryAttempts`, `failed_terminal`). `reconcile(limit)` spends `limit` on rows that correlate to an operation; rows that correlate to none (foreign events on the same PayPal account) are deferred without using the budget, and one run scans at most `10 * limit` of them, so they no longer hide a matchable event behind them.

The kit includes concurrent cases (two claims, two transitions, two evidence inserts, two recovery workers), so run it against a real database, not a mock, and with a pool of at least two connections: `Promise.all` over one client runs the calls one after another, and the cases then pass without testing any locking. The lease cases use a 1 s lease by default (`leaseMs`, `leaseExpiryWaitMs`); raise it when a store round trip plus the clock skew between the database and the test process gets close to that. `MemoryPaymentReliabilityStore` passes it and is the reference behaviour, but it is for **tests and local experiments only**: it is not durable production storage.

#### Worked example: Postgres schema for a subscriptions-only host

The package ships no migrations; this is a schema that satisfies the `SubscriptionStore` contract. It was run against Postgres 16, and `runStoreConformance` passed all 41 cases (including the insert-time delivery-status case) against a store written for it (a throwaway `pg` implementation of the 20 `SubscriptionStore` methods plus `reviveUnmatchedEvidence`, about 250 lines, not shipped); your own store still has to pass the kit. Names are yours to choose. A subscriptions-only host needs the operation kinds `catalog_product`, `billing_plan`, `plan_lifecycle`, `subscription`, `subscription_cancel`, `subscription_suspend` and `subscription_activate`. The columns below are every `PaymentOperation` and `ProviderEvidenceRecord` field the subscription flows write or read; the remaining operation fields (`providerOrderId`, `providerCaptureId`, `providerRefundId`, `senderBatchId`, `senderItemId`, `providerPayoutBatchId`, `providerPayoutItemId`, `payoutStatus`, `recipientType`, `maskedDestination`, `recipientValue`, `providerFeeMinor`, `providerFeeCurrency`, `sellerRef`, `providerReferralId`) belong to checkout, payout and seller flows: add columns and tables for the families you use, and until then return them as `null`. Every non-optional `PaymentOperation` field must come back, `null` when unused (for example `item_ref` is the product or plan name that `createCatalogProduct` and `createBillingPlan` return as `name`).

```sql
-- Operations: one row per command (create product/plan/subscription, cancel, suspend, activate).
CREATE TABLE payment_operations (
  operation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_scope text NOT NULL,
  idempotency_key text NOT NULL,
  command_fingerprint text NOT NULL,
  provider_code text NOT NULL,
  account_ref text NOT NULL,
  application_ref text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox', 'live')),
  -- catalog_product, billing_plan, plan_lifecycle, subscription, subscription_cancel,
  -- subscription_suspend, subscription_activate. No CHECK: the conformance kit also creates a
  -- 'checkout' operation (a create kind the stale-submitted listing covers).
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'prepared'
    CHECK (status IN ('prepared', 'submitted', 'unknown', 'succeeded', 'failed')),
  correlation_id text,
  parent_operation_id uuid REFERENCES payment_operations (operation_id),
  failure_code text,
  failure_message text,
  approval_url text,
  item_ref text,                     -- product / plan name (written by createCatalogProduct and createBillingPlan)
  amount_minor text,                 -- decimal string, e.g. '999'; never a float
  currency_code text,
  provider_reference_id text,
  provider_product_id text,
  provider_plan_id text,
  provider_subscription_id text,
  product_status text,
  plan_status text,
  subscription_status text,
  offering_ref text,
  masked_subscriber text,
  subscriber_ref text,
  subscriber_email text,
  start_time timestamptz,
  next_billing_time timestamptz,
  lifecycle_reason text,
  provider_subscription_state_at timestamptz,  -- webhook ordering watermark
  provider_transaction_id text,                -- legacy watermark column, cleared by the engine
  subscription_state_json jsonb,               -- reducer state without a column of its own
  execution_lease_expires_at timestamptz,      -- create execution lease
  execution_owner_token text,
  attempts integer,                            -- retry bookkeeping, all three nullable
  next_attempt_at timestamptz,
  retry_status text CHECK (retry_status IS NULL OR retry_status = 'gave_up'),
  version integer NOT NULL DEFAULT 1,          -- every write: WHERE version = $expected, then version + 1
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX payment_operations_idempotency
  ON payment_operations (idempotency_scope, idempotency_key);
-- Provider ids: unique per (provider, account, environment); the reference across all kinds,
-- the others only among their own kind.
CREATE UNIQUE INDEX payment_operations_provider_reference
  ON payment_operations (provider_code, account_ref, environment, provider_reference_id)
  WHERE provider_reference_id IS NOT NULL;
CREATE UNIQUE INDEX payment_operations_provider_subscription
  ON payment_operations (provider_code, account_ref, environment, provider_subscription_id)
  WHERE kind = 'subscription' AND provider_subscription_id IS NOT NULL;
CREATE UNIQUE INDEX payment_operations_provider_plan
  ON payment_operations (provider_code, account_ref, environment, provider_plan_id)
  WHERE kind = 'billing_plan' AND provider_plan_id IS NOT NULL;
CREATE UNIQUE INDEX payment_operations_provider_product
  ON payment_operations (provider_code, account_ref, environment, provider_product_id)
  WHERE kind = 'catalog_product' AND provider_product_id IS NOT NULL;
-- listUncertainOperations: `unknown` (and stale `submitted`) rows, due rows first.
CREATE INDEX payment_operations_uncertain
  ON payment_operations ((COALESCE(next_attempt_at, created_at)), operation_id)
  WHERE retry_status IS NULL AND status IN ('unknown', 'submitted');

-- One history row per transition, written in the same transaction as the status change.
CREATE TABLE payment_operation_transitions (
  transition_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL REFERENCES payment_operations (operation_id),
  from_status text NOT NULL,
  to_status text NOT NULL,
  evidence_id uuid,
  reason text NOT NULL,                        -- free text for people; services never read it
  transition_kind text CHECK (transition_kind IN ('claim_execution', 'claim_retry')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_operation_transitions_operation
  ON payment_operation_transitions (operation_id, created_at);

-- Evidence inbox: webhooks and reconciliation lookups.
CREATE TABLE payment_provider_evidence (
  evidence_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_code text NOT NULL,
  account_ref text NOT NULL,
  application_ref text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox', 'live')),
  evidence_kind text NOT NULL CHECK (evidence_kind IN ('webhook', 'reconciliation')),
  provider_event_id text NOT NULL,
  related_operation_id uuid REFERENCES payment_operations (operation_id),
  received_at timestamptz NOT NULL DEFAULT now(),
  verification_status text NOT NULL DEFAULT 'pending'
    CHECK (verification_status IN ('pending', 'verified', 'rejected')),
  payload_sha256 text NOT NULL,
  raw_payload text NOT NULL,                   -- the exact body; never re-serialise it
  processing_status text NOT NULL DEFAULT 'pending'
    CHECK (processing_status IN ('pending', 'processed', 'unmatched', 'unsupported', 'failed')),
  event_type text,
  resource_id text,
  error_code text,
  error_message text,
  claim_lease_expires_at timestamptz,
  claim_worker_id text,
  processed_at timestamptz,
  -- NULL = "not a delivery": no default! The engine sets 'pending' itself on processed webhook rows;
  -- a default would make reconciliation's own rows deliveries to your consumer. Map NULL to undefined.
  consumer_delivery_status text
    CHECK (consumer_delivery_status IN ('pending', 'confirmed', 'failed', 'failed_terminal')),
  consumer_delivered_at timestamptz,
  consumer_delivery_attempts integer,
  consumer_delivery_last_error text,
  attempts integer,
  next_attempt_at timestamptz,
  retry_status text CHECK (retry_status IS NULL OR retry_status = 'gave_up'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The dedupe key: a second insert of one PayPal event id must fail (map it to EVIDENCE_DUPLICATE).
CREATE UNIQUE INDEX payment_provider_evidence_event
  ON payment_provider_evidence (provider_code, account_ref, environment, provider_event_id);
-- claimPendingEvidence and listReconciliationCandidates: due rows in retry order.
CREATE INDEX payment_provider_evidence_due
  ON payment_provider_evidence ((COALESCE(next_attempt_at, received_at)), evidence_id)
  WHERE retry_status IS NULL
    AND (processing_status <> 'processed' OR consumer_delivery_status <> 'confirmed');
-- reviveUnmatchedEvidence (optional method).
CREATE INDEX payment_provider_evidence_resource
  ON payment_provider_evidence (provider_code, account_ref, environment, resource_id)
  WHERE processing_status = 'unmatched';

CREATE TABLE payment_reconciliation_attempts (
  attempt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_id uuid NOT NULL REFERENCES payment_provider_evidence (evidence_id),
  operation_id uuid REFERENCES payment_operations (operation_id),
  outcome text NOT NULL CHECK (outcome IN ('applied', 'retryable_failure', 'terminal_failure', 'no_op')),
  result_code text,
  result_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

`subscription_state_json` may be `text` or `jsonb`; with `jsonb` the driver may return an object, which the engine reads. `listUncertainOperations` and `listReconciliationCandidates` filter `retry_status IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= now())` and use the order shown by the two indexes; `listReconciliationCandidates` adds `evidence_kind = 'webhook'`, `verification_status = 'verified'` and `processing_status = 'unmatched'` (or a related operation in `unknown`).

**Lease claim.** `claimPendingEvidence` must hand a row to one worker only, honour every field of `ClaimPendingEvidenceInput` (the scope filters are optional, `evidenceIds` skips the backoff test, `includeConsumerDelivery` and `includePendingVerification` are flags that can be `true` or `false`) and return the rows in retry order. With `FOR UPDATE SKIP LOCKED`, sorted after `RETURNING` (an `UPDATE ... RETURNING` does not keep the subquery's `ORDER BY`):

```sql
-- $1 provider_code, $2 account_ref, $3 environment (NULL = any), $4 worker id, $5 lease ms, $6 limit,
-- $7 includeConsumerDelivery, $8 includePendingVerification, $9 evidenceIds (NULL = not given).
WITH due AS (
  SELECT evidence_id
  FROM payment_provider_evidence
  WHERE ($1::text IS NULL OR provider_code = $1)
    AND ($2::text IS NULL OR account_ref = $2)
    AND ($3::text IS NULL OR environment = $3)
    AND ($9::uuid[] IS NULL OR evidence_id = ANY($9))
    AND ($8::boolean OR verification_status <> 'pending')    -- includePendingVerification
    AND (
      -- rows that still need processing (a row that gave up is not claimed again) ...
      (retry_status IS NULL AND (
        verification_status = 'pending'
        OR (verification_status = 'verified' AND processing_status IN ('pending', 'unmatched'))
      ))
      -- ... and processed rows whose consumer delivery is open (its own cap, so retry_status is ignored)
      OR (verification_status = 'verified' AND processing_status = 'processed'
          AND consumer_delivery_status IN ('pending', 'failed') AND $7::boolean)
    )
    AND ($9::uuid[] IS NOT NULL OR next_attempt_at IS NULL OR next_attempt_at <= now())
    AND (claim_lease_expires_at IS NULL OR claim_lease_expires_at <= now() OR claim_worker_id = $4)
  ORDER BY COALESCE(next_attempt_at, received_at), evidence_id
  LIMIT $6
  FOR UPDATE SKIP LOCKED
), claimed AS (
  UPDATE payment_provider_evidence e
  SET claim_worker_id = $4,
      claim_lease_expires_at = now() + make_interval(secs => $5::double precision / 1000),
      updated_at = now()
  FROM due
  WHERE e.evidence_id = due.evidence_id
  RETURNING e.*
)
SELECT * FROM claimed
ORDER BY COALESCE(next_attempt_at, received_at), evidence_id;
```

The `processed` branch is deliberately not limited by `retry_status`: a row that gave up keeps its consumer delivery, which has its own cap. Without locking, the same query works as a conditional per-row update, which may return fewer rows than `limit` under contention. **Do not trust a query by reading it: the conformance kit must pass against the finished store** (a variant that hard-coded `includePendingVerification: false` failed three kit cases).

**What the engine writes at insert time.** `insertEvidence` leaves every delivery field empty: `consumer_delivery_status` stays `NULL` for every new row, and your store returns it as `undefined` (the engine reads `NULL` the same way, but the type does not allow `null`). The engine sets `consumerDeliveryStatus: 'pending'` itself, on a **processed webhook row**, when it marks the row processed. Reconciliation rows (`evidence_kind = 'reconciliation'`) never get a status and are never delivered to your consumer. A column default of `'pending'` would turn every reconciliation lookup into an event for your consumer; the conformance kit pins the insert-time value. A row read back without a status counts as delivered (legacy rows).

**Moving a 0.2.x store to 0.3.** On tables that already hold the 0.2 columns:

```sql
ALTER TABLE payment_operations
  ADD COLUMN subscription_state_json jsonb,
  ADD COLUMN attempts integer,
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN retry_status text CHECK (retry_status IS NULL OR retry_status = 'gave_up');

ALTER TABLE payment_provider_evidence
  ADD COLUMN attempts integer,
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN retry_status text CHECK (retry_status IS NULL OR retry_status = 'gave_up');

-- A CHECK with the three 0.2 delivery values rejects 'failed_terminal': widen it
-- (the constraint name is what your schema gave it; this is Postgres's default).
ALTER TABLE payment_provider_evidence
  DROP CONSTRAINT payment_provider_evidence_consumer_delivery_status_check,
  ADD CONSTRAINT payment_provider_evidence_consumer_delivery_status_check
    CHECK (consumer_delivery_status IN ('pending', 'confirmed', 'failed', 'failed_terminal'));
-- Do not add a DEFAULT to consumer_delivery_status, and leave existing rows as they are.

ALTER TABLE payment_operation_transitions
  ADD COLUMN transition_kind text CHECK (transition_kind IN ('claim_execution', 'claim_retry'));

-- plus payment_operations_uncertain and payment_provider_evidence_due from above
```

All new columns are nullable (or defaulted), so old rows keep working. A store that keeps the 0.2 shape still runs but without fairness (no backoff, never gives up) and the conformance kit fails it.

**Alert and reset.** Alert on rows the engine stopped retrying, fix the cause, then reset them:

```sql
SELECT 'operation' AS what, operation_id AS id FROM payment_operations WHERE retry_status = 'gave_up'
UNION ALL
SELECT 'evidence', evidence_id FROM payment_provider_evidence WHERE retry_status = 'gave_up';

UPDATE payment_provider_evidence SET retry_status = NULL, attempts = NULL, next_attempt_at = NULL
WHERE evidence_id = $1;   -- same three columns on payment_operations
```

### `PaymentEventConsumer`

**Purpose:** After webhook evidence is **verified** and **processed**, deliver a compact `VerifiedProcessedPaymentEvent` into your domain.

**You implement** `deliver(event)` with **idempotent** projections. Delivery is **at least once**: an event is delivered again when the acknowledgement write fails after `deliver` resolved, or when a lease expires mid-delivery. Dedupe on `providerEventId`.

The event carries `evidenceId`, `providerEventId`, `providerCode`, `accountRef`, `applicationRef`, `environment`, `eventType`, `resourceId`, `relatedOperationId`, `processingStatus` and `verificationStatus`. The raw provider body is included as `rawPayload` only with `new PaymentRecoveryService({ ..., includeRawPayload: true })`.

The module sets `consumerDeliveryStatus` to `pending` on every webhook row it marks processed, whether or not you wired a consumer (reconciliation rows get no status and are never delivered). **`PaymentRecoveryService`** invokes `consumer.deliver` during recovery when delivery is not finished. A throw records a sanitized error, increments `consumerDeliveryAttempts` and sets `failed`; after `maxConsumerDeliveryAttempts` failures (default 10, `DEFAULT_MAX_CONSUMER_DELIVERY_ATTEMPTS`) the row becomes `failed_terminal` and is no longer claimed. Find such rows with `listProviderEvidenceForRecovery` or your own query on `consumer_delivery_status = 'failed_terminal'`; set the status back to `failed` (and the attempts below the cap) to retry them.

If you do not use consumer delivery tracking, understand that `isConsumerDeliveryComplete()` treats **undefined** `consumerDeliveryStatus` as complete — set `pending` when you rely on delivery semantics (see `AGENTS.md`).

### Provider ports

Provider ports describe **PayPal-side execution** wired into lifecycle services:

| Port | Lifecycle service | PayPal builder |
|------|-------------------|----------------|
| `CheckoutProviderPort` | `CheckoutLifecycleService` | `buildPaypalCheckoutExecutor` |
| `SubscriptionProviderPort` | `SubscriptionLifecycleService` | `buildPaypalSubscriptionExecutor` |
| `PayoutProviderPort` | `PayoutLifecycleService` | `buildPaypalPayoutExecutor` |
| `SellerOnboardingProviderPort` | `SellerOnboardingLifecycleService` | `buildPaypalSellerOnboardingExecutor` |
| `MarketplaceProviderPort` | `MarketplaceLifecycleService` | `buildPaypalMarketplaceExecutor` |
| `ReconciliationProviderLookup` | `ReconciliationService`, webhook subscription refresh | Combine executor `get*` methods |
| `WebhookSubscriptionProviderLookup` | `WebhookProcessingService` (optional) | Subscription `getSubscription` |

---

## Main data contracts (overview)

| Type | Created by | Consumed by | Role |
|------|------------|-------------|------|
| `PaymentProviderConfig` | Consumer | `resolvePaymentRuntime`, PayPal factories | Explicit provider/account/environment/capability configuration |
| `ProviderEvidence` | Module (public fields) | Consumer read APIs | Safe evidence view without raw payload |
| `ProviderEvidenceRecord` | Store | Module services | Server-side evidence including `rawPayload` |
| `VerifiedProcessedPaymentEvent` | Module (from evidence) | `PaymentEventConsumer` | Delivery payload after successful processing |
| Webhook inputs / `WebhookReceiptResponse` | Consumer HTTP layer | `WebhookProcessingService.receiveWebhook` | Verified ingestion result |
| `RecoverPaymentReliabilityInput` / `RecoverPaymentReliabilityResult` | Consumer worker | `PaymentRecoveryService.recover` | Batch recovery summary |
| `RecoverPaymentEvidenceInput` | Consumer | `PaymentRecoveryService.recoverEvidence` | Single-evidence recovery |
| `ClaimPendingEvidenceInput` | Module | Store | Lease rows for recovery workers |
| `classifyPaymentFailure` / `toPublicFailure` | Consumer mapping layer | Your API responses | Structured failure codes for clients |
| `OperationResult` patterns | Module + contracts | Consumer | Normalized success/failure envelopes |

Field-level documentation lives in **`AGENTS.md`** and generated TypeScript declarations under `dist/*.d.ts`.

---

## Webhook flow

```text
Consumer HTTP endpoint (raw body + the five PayPal-Transmission headers)
  → WebhookProcessingService.receiveWebhook
      intake checks (before anything is stored or sent to PayPal)
  → evidence persisted (idempotent by providerEventId)
  → verify() callback (PaypalWebhookVerifier → PayPal verify-webhook-signature)
  → normalise → reduce → persist on the subscription operation
  → consumerDeliveryStatus pending when business delivery is required
  → PaymentRecoveryService + PaymentEventConsumer (delivery acknowledgement)
```

**Consumer-owned:** TLS termination, route, authentication, reading the raw body, PayPal transmission headers, calling `verify`.

**Module behavior:**

- Duplicate deliveries with the same `providerEventId` are idempotent (unique evidence key); a known id with a different body is `WebhookEventPayloadMismatchError`.
- **`receipt.duplicate` is `true` only once nothing is left to do.** A redelivery of a processed event is acknowledged as a duplicate only when its consumer delivery is complete (`confirmed` or `failed_terminal`, or a legacy row without a status). The engine marks every processed webhook row `pending` for delivery, so a host **without** a `PaymentEventConsumer` (or whose recovery has not delivered yet) sees `duplicate: false` on a redelivery; the redelivery is still harmless (it resumes the row and changes nothing). Do not use `duplicate` as your own dedupe flag; dedupe on `providerEventId`.
- Incomplete duplicates may resume via `classifyWebhookEvidenceResume` / `reprocessStoredWebhookEvidence` (see tests).
- Verification failures classify into retryable unavailable vs terminal rejection (`VerifyWebhookResult.failureKind`). Only a 2xx answer from PayPal with `verification_status: 'FAILURE'` is a rejection; any non-2xx answer (400, 401, 403, 5xx), non-JSON body, timeout or a 2xx without `verification_status` is `verification_unavailable`: the evidence stays `pending` and a redelivery verifies it.
- The verify request carries the **original raw event text** as `webhook_event` (the outer JSON is built around it, never re-serialised), as PayPal requires.
- Operational error strings are sanitized before persistence where applicable.

### End-to-end example

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PAYMENT_RELIABILITY_ERROR,
  PaymentReliabilityError,
  WebhookProcessingService,
  resolvePaymentRuntime,
  type PaypalWebhookTransmissionHeaders,
} from '@idevconn/payment-providers';
import { buildPaypalWebhookVerifier } from '@idevconn/payment-providers/paypal';

const runtime = resolvePaymentRuntime({ config, nodeEnv: process.env.NODE_ENV });

const verifier = buildPaypalWebhookVerifier({
  runtime,
  nodeEnv: process.env.NODE_ENV,
  webhookId: process.env.PAYPAL_WEBHOOK_ID, // your code reads the variable
  requireWebhookId: true, // fail at start-up, not on every request (default in production)
});

const webhooks = new WebhookProcessingService(
  store, // a SubscriptionStore is enough for subscriptions
  subscriptionExecutor, // optional: its getSubscription reads PayPal's state before a status event is applied
  {
    maxBodyBytes: 262_144, // default 256 KiB of UTF-8
    requireTransmissionHeaders: true, // reject a request without the five headers
    maxTransmissionAgeMs: 72 * 3_600_000, // opt-in freshness window; off by default
    maxTransmissionFutureMs: 300_000, // used only when the age window is on
  },
  { onSubscriptionEffects: async (operationId, effects, context) => { /* your product rules */ } },
);

export async function handlePaypalWebhook(req: IncomingMessage, res: ServerResponse) {
  // The EXACT bytes PayPal signed: read the body as text and pass it on unchanged. No JSON parse and
  // stringify, no body-parser that re-encodes, no trimming; the framework must give you the raw body.
  const rawBody = await readRawBody(req);
  const header = (name: string) => String(req.headers[name] ?? '');
  const headers: PaypalWebhookTransmissionHeaders = {
    transmissionId: header('paypal-transmission-id'),
    transmissionTime: header('paypal-transmission-time'),
    certUrl: header('paypal-cert-url'),
    authAlgo: header('paypal-auth-algo'),
    transmissionSig: header('paypal-transmission-sig'),
  };

  try {
    const receipt = await webhooks.receiveWebhook({
      providerCode: runtime.context.providerCode,
      accountRef: runtime.context.accountRef,
      applicationRef: runtime.context.applicationRef,
      environment: runtime.context.environment,
      rawBody,
      headers, // the SAME object feeds the intake checks and the verify closure below
      // providerEventId is optional: it defaults to the body `id`, and a value that differs is rejected
      verify: () =>
        verifier.verify({
          providerCode: runtime.context.providerCode,
          accountRef: runtime.context.accountRef,
          environment: runtime.context.environment,
          webhookId: process.env.PAYPAL_WEBHOOK_ID!,
          headers,
          rawBody,
        }),
    });
    res.writeHead(200).end(JSON.stringify({ duplicate: receipt.duplicate }));
  } catch (error) {
    // A 5xx makes PayPal redeliver (its documentation describes retries for about 3 days); a 4xx tells it to stop.
    const code = error instanceof PaymentReliabilityError ? error.code : null;
    const retry =
      code === null ||
      code === PAYMENT_RELIABILITY_ERROR.VERIFICATION_UNAVAILABLE ||
      code === PAYMENT_RELIABILITY_ERROR.PERSISTENCE_FAILURE;
    res.writeHead(retry ? 503 : 400).end();
  }
}
```

Intake options (`WebhookIntakeOptions`, third constructor argument; invalid values throw `PaymentConfigurationError` at construction):

| Option | Default | Effect |
|--------|---------|--------|
| `maxBodyBytes` | `DEFAULT_WEBHOOK_MAX_BODY_BYTES` (262144) | Larger bodies are rejected with `INVALID_REQUEST` before any store call |
| `requireTransmissionHeaders` | `false` | Without `headers` the request is rejected. When headers are passed, all five must be non-blank either way |
| `maxTransmissionAgeMs` | `null` (off) | An event id never seen before whose `transmissionTime` is older is rejected. Per PayPal's documentation a failed delivery is retried for about 3 days; the retry's `transmissionTime` is assumed to be the original one, which has not been observed here, so verify a sandbox redelivery before you enable this option, and use at least 72 h (259200000). A stored event always resumes, whatever its time |
| `maxTransmissionFutureMs` | `DEFAULT_WEBHOOK_MAX_TRANSMISSION_FUTURE_MS` (300000) | Largest accepted future skew; used only when the age window is on |
| `maxTransmissionSkewMs` | off | Deprecated alias that sets both directions |

`providerEventId` on `ReceiveWebhookInput` is optional: it defaults to the `id` of the body, a value that differs from the body `id` is rejected, and so is a request with no id anywhere. Intake rejections are `PaymentReliabilityError` with code `INVALID_REQUEST`, the messages name fields and never values, and nothing is stored.

**Always use the same `headers` object for `receiveWebhook` and for the `verify` closure**: the intake checks look at what you pass, the signature check at what you send to PayPal.

**Raw body, byte for byte.** Signature verification and the payload hash only hold for the exact string you pass. A proxy or framework that re-serialises JSON, changes line endings or decodes with a charset other than UTF-8 breaks both (a changed body of a known event id is `WEBHOOK_PAYLOAD_MISMATCH`, permanent for that delivery).

After `processingStatus: 'processed'`, run or schedule **`PaymentRecoveryService.recover`** (with `PaymentEventConsumer` wired) to perform delivery and persist `consumerDeliveryStatus: 'confirmed'`.

### Subscription events: pure core, state and effects


Subscription webhooks (`BILLING.SUBSCRIPTION.*`, `BILLING.SUBSCRIPTION.PAYMENT.FAILED`, `PAYMENT.SALE.COMPLETED/REFUNDED/REVERSED`) and subscription reconciliation run through the pure core (`normalizePaypalSubscriptionEvent` → `reduceSubscription`, see [Pure core](#pure-core)). The engine persists what the reducer returns on the subscription operation: status, plan, state watermark, `nextBillingTime`, `startTime` and, in `subscriptionStateJson`, the last payment and failed-payment count (`readSubscriptionOperationState(operation)`).

- **Plan check without a lookup:** an event whose `plan_id` differs from the stored `providerPlanId` never grants access; the evidence stays `pending` with `SUBSCRIPTION_PLAN_MISMATCH` (reconciliation records a `terminal_failure`). Cancellations, suspensions and expiries on another plan still apply and report `plan_mismatch`. This holds for webhooks, reconciliation and the provider state returned by `cancelSubscription` / `suspendSubscription` / `activateSubscription`, which run through the same reducer (the watermark never moves back, billing fields are stored, effects reach the hook).
- **Amount check:** `createBillingPlan` stores the lowest paid cycle price (or setup fee) on the plan operation (`amountMinor`/`currencyCode`). A completed sale in another currency or below that price is reported (`currency_mismatch` / `amount_mismatch`) and not recorded as the last payment. A subscription's own `amountMinor`/`currencyCode` win when set; without a known price only the plan id is checked. Two limits: (1) a priced trial or a setup fee below the regular price lowers the expected amount, so a regular renewal at that lower amount passes (underpayment detection is weaker for such plans); (2) after the price goes down at PayPal (pricing update, or a revise to a cheaper plan) every renewal is `amount_mismatch` and no last payment is recorded until you store the new amount with `adoptSubscriptionPlan` or the subscription's own `amountMinor`/`currencyCode`.
- **Effects hook:** pass `{ onSubscriptionEffects(operationId, effects, context) }` as the last constructor argument of `WebhookProcessingService`, `ReconciliationService` and `SubscriptionLifecycleService` (`context.source` is `webhook`, `reconciliation` or `lifecycle`). It runs after the state is saved; the package puts no business logic there. Effects: `status_changed`, `payment_completed`, `payment_failed`, `plan_mismatch`, `amount_mismatch`, `currency_mismatch`, `refund_or_reversal`, `period_updated`. The guarantee is **at least once per evidence row (or lifecycle command), never zero**:
  - effects of a state change are held in `subscriptionStateJson` until the hook returns. If it throws, the row stays `pending` with `SUBSCRIPTION_EFFECTS_HOOK_FAILED` and the same batch is delivered again when the row is reprocessed (`PaymentRecoveryService` uses the webhook service, so give the webhook service the same hook as reconciliation; without one the row stays `pending` with `SUBSCRIPTION_EFFECTS_HOOK_MISSING`). A lifecycle command whose hook throws fails with `SUBSCRIPTION_EFFECTS_HOOK_FAILED` after the state is saved; replay it with the same idempotency key to deliver again;
  - at most 16 batches are held per subscription; a row that would need one more is not applied and stays `pending` with `HELD_EFFECTS_OVERFLOW` until the hook drains the backlog (held batches are never dropped);
  - effects of a row that changed nothing (`amount_mismatch`, `currency_mismatch`) are recomputed and delivered on each reprocessing until one delivery succeeds;
  - a `plan_mismatch` that keeps a row `pending` is delivered once per row while it stays pending (the last 32 such rows per subscription are remembered; lookups during reconciliation are remembered per foreign plan), not on every recovery run.
  Make the hook idempotent (for example on `context.evidenceId` and the effect).
- **Commands:** an uncertain cancel/suspend/activate command is reconciled by looking up its subscription: the lookup is applied to the subscription operation and the command ends `succeeded` (target status reached) or `failed` with `SUBSCRIPTION_COMMAND_NOT_APPLIED`. Provider ids stay on the subscription operation only.
- **Same id, other body:** a webhook whose `providerEventId` is already stored but whose body hash differs is rejected with `WebhookEventPayloadMismatchError` (code `WEBHOOK_PAYLOAD_MISMATCH`) before any processing. The raw body must reach `receiveWebhook` byte for byte on every delivery (no re-serialisation, no charset or line-ending changes by a proxy). The error is permanent for that delivery: answer non-2xx and fix the transport; resending the altered body never succeeds. A row stored before its verification succeeded (for example `VERIFICATION_UNAVAILABLE`) can only be verified by a byte-identical PayPal redelivery.

#### Plan revision / adopting a new plan

When PayPal moves a subscription to another plan (a revise, or a plan you accept), events carrying the new `plan_id` stay `pending` with `SUBSCRIPTION_PLAN_MISMATCH` and access is not granted on it. Accept the plan with:

```ts
import { adoptSubscriptionPlan } from '@idevconn/payment-providers';

await adoptSubscriptionPlan({
  store,
  operationId: subscriptionOperationId,
  providerPlanId: 'P-NEW',
  amountMinor: '500', // expected price on the new plan; undefined keeps, null clears
  currencyCode: 'USD',
  webhookProcessing: webhooks, // optional: reprocess the pending rows now
});
```

It updates the subscription operation's plan (and expected price) in one compare-and-set write and forgets the mismatches reported so far. With `webhookProcessing` the rows the engine remembered as `pending` for the old plan check (remembered when a hook is configured) are reprocessed at once; otherwise `PaymentRecoveryService` applies them on its next run. Product consequences (entitlements, proration) stay in your code.

#### Subscription create: idempotency and retries

- The command fingerprint of `createSubscription` / `retrySubscriptionCreate` covers every field that shapes the PayPal request: plan reference, `subscriberRef`, subscriber email, `returnUrl`/`cancelUrl`, `customId`, `shippingPreference`, `brandName`, `userAction` and `productType`. The same idempotency key with any other value throws `IDEMPOTENCY_CONFLICT` before PayPal is called (issue #25). Unused fields are left out, so a request without email or optional fields keeps its 0.2 fingerprint; a row created by 0.2 with an email (fingerprint without it) still matches a request whose email equals the stored `subscriberEmail`. The email is compared verbatim: `A@B.c`, `a@b.c` and ` A@B.c` are different requests (`IDEMPOTENCY_CONFLICT`, nothing is sent), so pass it exactly as on the first call.
- A create retry that overlaps the still running original (same PayPal-Request-Id, so PayPal returns one subscription) no longer leaves the row `unknown` (issue #22): whichever call gets the PayPal response stores it, the other returns the stored row, and a timeout of one call never overwrites the other's stored subscription. A retry that took over a `submitted` row of a first call (which takes no lease) and gets a terminal 4xx (409, 422, for example "request in progress") records `unknown`, not `failed`: the first call's 201 then stores the subscription and its approval URL, and if it never answers, the next retry (from `unknown`) settles it; a 4xx there is `failed` as usual. Of two concurrent `createSubscription` calls with one key, the one that loses the claim returns the stored row instead of throwing `OPERATION_CONFLICT`.
- A worker that dies between the claim and the result write leaves the row `submitted` without provider id. After `submittedStaleAfterMs` (default 5 min) reconciliation marks it `unknown` (`PROVIDER_UNCERTAIN`); recover it with `retrySubscriptionCreate`, which sends the same PayPal-Request-Id (issue #12). Keep `submittedStaleAfterMs` longer than the PayPal request timeout (`requestTimeoutMs`, default 10 s) times the executor's internal attempts (token refresh retry), so only dead calls are marked. A slow create that was marked `unknown` anyway is not lost: its own later success still stores the subscription (`unknown -> submitted`).

---

## Recovery

`PaymentRecoveryService` supports:

- **Batch recovery** — `recover({ workerId, environment, limit?, leaseMs?, evidenceIds?, providerCode?, accountRef? })`
- **Single evidence** — `recoverEvidence({ evidenceId, workerId, environment, leaseMs? })`
- **Claim/lease** — uses `store.claimPendingEvidence` before work; lease cleared in `finally`
- **Summary counters** — `claimed`, `verified`, `processed`, `delivered`, `skipped`, `failed` and `deliveryFailed`. `delivered` counts only events the consumer received and that were acknowledged.
- **Consumer errors** — `failed` counts rows whose processing or delivery-only retry failed. `deliveryFailed` (optional field of the `recover()` result, always set by the service) counts rows that were processed **in this run** and whose consumer delivery then failed; those rows are also counted in `processed`, not in `failed`. A consumer failure on a row that was already processed in an **earlier** run (the delivery-only retry) is still counted as `failed`. In both cases the failure is stored on the row (`consumer_delivery_status = 'failed'`, `consumer_delivery_attempts`, `consumer_delivery_last_error`) and the delivery is retried with backoff until `failed_terminal`.
- **No consumer** — with `consumer: null`, rows that only await delivery are not claimed (`includeConsumerDelivery: false`) and `delivered` stays 0; a store must honour that flag (see [Implementing a store](#implementing-a-store)): rows it returns anyway are counted as `skipped` and released, but they fill the batch and starve newer rows.
- **Backoff** — a claimed row that still needs work afterwards (skipped, still `pending` or `unmatched`, failed) is released with `attempts`/`nextAttemptAt` and gives up after `maxAttempts` (see [retry backoff](#implementing-a-store)); the next run reaches the rows behind it. `recoverEvidence` (explicit `evidenceIds`) ignores the backoff of the row it names, not `gave_up`.

Recovery paths include reprocessing stored webhook evidence when verification already succeeded but processing or delivery did not complete, and **delivery-only retry** when processing succeeded but `consumerDeliveryStatus !== 'confirmed'`.

**Known limitation:** Evidence with `verificationStatus === 'pending'` is **not** re-verified by the recovery worker: recovery does not claim it (`includePendingVerification: false`). Those rows require the appropriate **webhook redelivery** or consumer-driven verification path — do not assume recovery will complete PayPal signature verification.

Helpers: `isRecoverableEvidenceRow`, `classifyWebhookEvidenceResume` (exported from root).

---


## Upgrading from 0.2.x

### Breaking changes

1. **Root no longer exports `LegacyPaymentError`** (runtime and type). Import it from `@idevconn/payment-providers/legacy`.
2. **`/paypal` no longer exports `PaypalPaymentProvider`, `createPaypalPaymentProvider`, `invokeCheckoutWhenReady` and the type `CheckoutOperation`.** They moved to `/legacy`.
3. **`@idevconn/payment` is an optional peer dependency**, no longer installed with this package. Install it only if you import `/legacy` (it brings its own peer `express@^5`).

```diff
- import { LegacyPaymentError } from '@idevconn/payment-providers';
- import { createPaypalPaymentProvider, PaypalPaymentProvider } from '@idevconn/payment-providers/paypal';
+ import { LegacyPaymentError, createPaypalPaymentProvider, PaypalPaymentProvider } from '@idevconn/payment-providers/legacy';
```

Type-level breaks for hosts that construct or switch over these types: `VerifiedProcessedPaymentEvent` gained the required `providerEventId`, and `ConsumerDeliveryStatus` gained `failed_terminal` (an exhaustive `switch` needs a case); `PaymentReliabilityErrorCode` gained `WEBHOOK_PAYLOAD_MISMATCH`, `SUBSCRIPTION_STATE_UNREADABLE`, `SUBSCRIPTION_STATE_VERSION_UNSUPPORTED` and `SUBSCRIPTION_EFFECTS_HOOK_FAILED`.

### Required host changes (store implementers)

- New nullable columns: `subscriptionStateJson` on operations (`text` or `jsonb`); `attempts`, `nextAttemptAt` and `retryStatus` on operations **and** evidence (the CHECK must allow `'gave_up'`); `transitionKind` on history rows. `consumerDeliveryStatus` must accept `'failed_terminal'`. See the [schema and migration](#worked-example-postgres-schema-for-a-subscriptions-only-host).
- `claimPendingEvidence` must honour `includeConsumerDelivery` and `includePendingVerification`; the three candidate lists use the new `COALESCE(next_attempt_at, ...)` order; `listUncertainOperations(limit, options)` takes a second argument; optional `reviveUnmatchedEvidence`.
- Run `runStoreConformance` against the store; it covers all of the above.

### New constructor parameters and options

- `WebhookProcessingService(store, subscriptionLookup?, intakeOptions?, hooks?)`: `intakeOptions` (`maxBodyBytes`, `maxTransmissionAgeMs`, `maxTransmissionFutureMs`, `requireTransmissionHeaders`) and `hooks` (`{ onSubscriptionEffects }`).
- `ReconciliationService(store, lookup, hooks?, options?)`: `hooks` and `{ retryBaseDelayMs, retryMaxDelayMs, maxAttempts, submittedStaleAfterMs }`.
- `SubscriptionLifecycleService(store, provider, hooks?)`.
- `PaymentRecoveryService({ ..., retryBaseDelayMs, retryMaxDelayMs, maxAttempts, maxConsumerDeliveryAttempts, includeRawPayload })`.
- `ReceiveWebhookInput`: `providerEventId` is optional, new optional `headers`.
- `buildPaypalWebhookVerifier`: `webhookId`, `requireWebhookId`; all factories and `resolvePaymentRuntime`: `allowRejectOnlyInProduction`.
- `CreateSubscriptionRequest`: `customId`, `shippingPreference`, `brandName`, `userAction`, `productType`; all request-shaping fields, including the subscriber email, are part of the idempotency fingerprint.

### Behaviour changes to know about

- Production no longer boots reject-only on missing credentials or an unconfigured execution status (see [Production guards](#production-guards)).
- A 401 from PayPal is retried once with a fresh token; a failed or 4xx/5xx signature check is `verification_unavailable` (the evidence stays `pending`), not a rejection.
- `PAYMENT.SALE.*` and `BILLING.SUBSCRIPTION.PAYMENT.FAILED` change the stored state and produce effects; `BILLING.SUBSCRIPTION.UPDATED` is processed; an event on another plan than the stored one never grants access (`SUBSCRIPTION_PLAN_MISMATCH`, adopt the plan with `adoptSubscriptionPlan`).
- Candidate lists are fair: unresolved rows back off and give up after `maxAttempts` (default 100); recovery never claims rows that await verification and, without a consumer, never claims delivery-only rows.
- Failed consumer deliveries stop at `maxConsumerDeliveryAttempts` (default 10, `failed_terminal`); the consumer receives a narrowed event without `rawPayload` unless `includeRawPayload` is set.
- A create retry overlapping its original returns one stored subscription; uncertain cancel, suspend and activate commands reconcile to `succeeded` or `failed`.
- REGULAR billing cycles need a positive price, TRIAL cycles come first; every id interpolated into a PayPal URL path is encoded (empty, `.` and `..` ids are rejected).
- Live HTTP clients refuse redirects.

---

## Known limits

- **Raw body.** Verification and the payload hash need the exact string PayPal sent; a host that re-serialises or re-decodes the body breaks them, and a body altered for a known event id is rejected for good.
- **No lease around reconciliation of evidence.** `ReconciliationService` takes no lease on evidence rows; two `reconcile()` workers can process one row twice and lose an `attempts` increment (the cap is reached a little later). Run one reconcile worker per scope, or accept the duplicate lookup.
- **Rows rejected by 0.2.x stay rejected.** Evidence that 0.2.x stored as `rejected` after a verification answer of 400, 401 or 403 is terminal; from 0.3 such answers are retryable, but the old rows are not re-verified. Reset them by hand if you know the cause was ours (`verification_status = 'pending'`, clear `error_code`) and let PayPal redeliver.
- **Price rule.** The expected amount of a sale is the lowest positive cycle price or setup fee stored by `createBillingPlan`: a priced trial or a setup fee below the regular price weakens underpayment detection, and after a price drop at PayPal every renewal is `amount_mismatch` until you store the new price (`adoptSubscriptionPlan` or the operation's own amount). Subscriptions created from a `providerPlanId` without a plan operation get only the plan-id check.
- **Same-second status conflicts.** PayPal's `update_time` has second precision. When a webhook's status differs from the stored one at the **same** timestamp, the provider decides: with a lookup (the second argument of `WebhookProcessingService`) the provider's snapshot is applied and wins; reconciliation does the same with its lookup. Without a lookup the event is not applied and not marked processed: the evidence becomes `unmatched` with the code `SUBSCRIPTION_STATE_CONFLICT_EQUAL_TIMESTAMP` and its `relatedOperationId` set, and the next `reconcile()` run repairs it with its lookup (a failed lookup records a retryable attempt and leaves the row). The pure reducer alone still reports `equal_conflict` as a noop; there the host decides.
- **Pending by design.** Rows that wait for the host (`SUBSCRIPTION_PLAN_MISMATCH`, `HELD_EFFECTS_OVERFLOW`, `SUBSCRIPTION_EFFECTS_HOOK_MISSING`) are retried with backoff and give up like any other row.
- **One OAuth client per factory call**, and the OAuth base URL follows `credentials.environment`; build each executor once and reuse it.
- **Providers.** Only PayPal is implemented.

---
## Errors and security

- Branch on **structured codes** (`PAYMENT_RELIABILITY_ERROR`, `PaymentReliabilityError`, `classifyPaymentFailure`, `toPublicFailure`, `resolveProviderFailure`) — do not match error message text in your own code. (One internal check does exactly that: `ReconciliationService.recordReconciliationFailure` recognises a terminal-status failure by the fragment `Terminal operation status` of its message; this is pre-existing, not a contract, and may change.)
- Provider and consumer-facing messages go through sanitization helpers (`sanitizePublicErrorMessage`, `sanitizeOperationalErrorMessage`).
- Raw provider HTTP bodies and internal stack traces are **not** a public contract.
- Enforce idempotency and unique constraints in **your** store implementation.
- Use separate sandbox/live configuration and never cross-mix stored operations or evidence.

Configuration mistakes surface as `PaymentConfigurationError` (for example missing `applicationRef`).

---

## Consumer responsibilities

Intentional integration work — not missing module features:

- [ ] Load and validate PayPal (and future provider) secrets server-side
- [ ] Build and pass explicit `PaymentProviderConfig` (including required `applicationRef`)
- [ ] Implement durable `PaymentReliabilityStore`
- [ ] Implement idempotent `PaymentEventConsumer`
- [ ] Expose webhook HTTP transport and verify raw body integrity (the exact bytes, one `headers` object for intake and verify)
- [ ] Dedupe on `providerEventId` (and on the sale id) before the pure reducer, if you use the pure core without the engine
- [ ] Alert on `retry_status = 'gave_up'` and on `consumer_delivery_status = 'failed_terminal'`; configure `ReconciliationService` and `PaymentRecoveryService` with the same retry options
- [ ] Run `runStoreConformance` against your store, with a real database and at least two connections
- [ ] Authorize admin and command endpoints in your application
- [ ] Provide read/admin query APIs over your own schema
- [ ] Schedule recovery workers (`PaymentRecoveryService`) with unique `workerId`
- [ ] Maintain seller/marketplace connection projections required by your product
- [ ] Operate logs, metrics, and alerts around payment operations
- [ ] Test concurrency, duplicate webhooks, and idempotency keys

---

## Package boundaries

**This package does not provide:**

- Application UI or checkout pages
- Admin HTTP API or ORM models
- Database migrations or hosted persistence
- NestJS, Supabase, or other framework adapters
- Secret loading from environment files
- Deployment or infrastructure automation
- Full seller CRM or marketplace operator tools
- Application-specific ledger or entitlement rules
- Non-PayPal payment providers

It **does** provide reusable command-side orchestration, PayPal integration, and contracts your backend composes.

---

## Development and verification

From a clean clone, run in order (**build before test** — architecture and dist surface tests import `dist/`):

```bash
npm ci
npm run typecheck
npm run build
npm run test
npm run lint
npm pack --dry-run
```

`npm test` runs the whole suite, including the built-package checks (CommonJS/ESM identity, consumer type-checks with a real `tsc`, declarations free of `@idevconn/payment`, the pinned export names). CI also runs those files on their own as "Package smoke tests". After an intended change of a public name, regenerate the pinned lists with `UPDATE_EXPORT_SURFACE=1 npx vitest run test/public-exports.unit.test.ts test/dist-export-surface.test.ts` (build first) and review the diff of `test/fixtures/export-surface/`.

Contributors use Changesets for releases; consumers integrate via npm only.

---

## Additional documentation

| Resource | Description |
|----------|-------------|
| [`AGENTS.md`](./AGENTS.md) | Exhaustive integration contract, DTO reference, and port method inventory |
| [GitHub repository](https://github.com/iDEVconn/payment-providers) | Source and issues |
| [Issue tracker](https://github.com/iDEVconn/payment-providers/issues) | Bugs and feature requests |
| [LICENSE](./LICENSE) | Apache-2.0 |

---

## License

Apache-2.0 — see [LICENSE](./LICENSE).

