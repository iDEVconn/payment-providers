# @idevconn/payment-providers

Standalone npm library for **provider-neutral payment contracts**, **reusable payment lifecycle orchestration**, and **PayPal provider integration**. The module coordinates checkout, subscriptions, payouts, marketplace flows, seller onboarding, webhooks, reconciliation, and recovery while keeping **persistence and business projections behind consumer-implemented ports**.

You get:

- Shared payment contracts and operation/evidence models
- Lifecycle services that enforce idempotency, transitions, and claim/lease semantics
- `PaymentReliabilityStore` and `PaymentEventConsumer` ports (consumer-owned implementations)
- PayPal HTTP executors, OAuth, and webhook verification via `@idevconn/payment-providers/paypal`
- Webhook ingestion, duplicate handling, and incomplete-evidence resumption helpers
- `PaymentRecoveryService` for batch and single-evidence recovery, including consumer-delivery retries

The package does **not** load secrets, read `process.env`, or ship a database schema. Your backend supplies configuration, storage, HTTP endpoints, and admin/read APIs.

---

## Installation

Requires **Node.js `>=22.12.0`** (see `package.json` `engines`).

```bash
npm install @idevconn/payment-providers
```

### Entry points

| Import | Purpose |
|--------|---------|
| `@idevconn/payment-providers` | Contracts, lifecycle services, ports, webhook/recovery/reconciliation, runtime resolution, configuration types |
| `@idevconn/payment-providers/paypal` | PayPal provider composition, executors, OAuth, webhook verification, retry policies |
| `@idevconn/payment-providers/subscription` | Pure subscription core: PayPal event normalisation and the subscription state reducer (no IO; see [Pure core](#pure-core)) |
| `@idevconn/payment-providers/legacy` | Legacy `@idevconn/payment` checkout surface: `createPaypalPaymentProvider`, `PaypalPaymentProvider`, `LegacyPaymentError`. The only entry that loads `@idevconn/payment`, an optional peer dependency: install it only if you import `/legacy` |

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

Types such as `PaymentProviderConfig` are exported for TypeScript; use `import type` where appropriate.

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
| Subscription (product, plan, lifecycle) | Implemented | Implemented (`SubscriptionProviderPort`, `PaypalSubscriptionExecutor`) | Store, billing projections |
| Payout batches | Implemented | Implemented (`PayoutProviderPort`, `PaypalPayoutExecutor`) | Store, sender identity policy |
| Refund (capture) | Implemented | Implemented via checkout executor | Store, refund idempotency |
| Marketplace checkout / capture / unit refund | Implemented | Implemented (`MarketplaceProviderPort`, `PaypalMarketplaceExecutor`) | Seller readiness data in store |
| Seller onboarding | Implemented | Implemented (`SellerOnboardingProviderPort`, `PaypalSellerOnboardingExecutor`) | Seller connection records in store |
| Webhook verification | Implemented | Implemented (`PaypalWebhookVerifier`, `buildPaypalWebhookVerifier`) | HTTP route, raw body, headers |
| Webhook duplicate handling | Implemented | N/A | Stable `providerEventId` per delivery |
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
- `PaypalPaymentProvider` — capability descriptor, `createCheckoutStrategy()` for `@idevconn/payment` `PaymentStrategy` compatibility

**Executors** (typically constructed with `ResolvedPaymentRuntime` from `resolvePaymentRuntime`):

- `buildPaypalCheckoutExecutor` → `PaypalCheckoutExecutor`
- `buildPaypalSubscriptionExecutor` → `PaypalSubscriptionExecutor`
- `buildPaypalPayoutExecutor` → `PaypalPayoutExecutor`
- `buildPaypalSellerOnboardingExecutor` → `PaypalSellerOnboardingExecutor`
- `buildPaypalMarketplaceExecutor` → `PaypalMarketplaceExecutor`

**Webhooks and HTTP**

- `buildPaypalWebhookVerifier` → `PaypalWebhookVerifier`
- `PaypalOAuthClient`, live/fake HTTP clients for orders, subscriptions, payouts, seller onboarding
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

const webhooks = new WebhookProcessingService(store /*, optional subscription lookup */);

const verifier = buildPaypalWebhookVerifier({ runtime, nodeEnv: process.env.NODE_ENV });

const recovery = new PaymentRecoveryService({
  store,
  webhookProcessing: webhooks,
  consumer,
});

// Example: create checkout order (module API — see contracts for request shapes)
// await checkout.createCheckoutOrder({ ... });

// Example: HTTP webhook handler (consumer-owned transport)
// await webhooks.receiveWebhook({
//   providerCode: runtime.context.providerCode,
//   accountRef: runtime.context.accountRef,
//   applicationRef: runtime.context.applicationRef,
//   environment: runtime.context.environment,
//   rawBody,
//   providerEventId: headers['paypal-transmission-id'],
//   verify: () => verifier.verify({ webhookId: config.credentials!.webhookId!, headers, rawBody }),
// });

// Example: background recovery worker (consumer-owned scheduler)
// await recovery.recover({ workerId: 'worker-1', environment: 'sandbox', limit: 25 });
```

Replace placeholders with your storage, routing, and authorization. See `AGENTS.md` in the repository for exhaustive request/response shapes and store method contracts.

---

## Core consumer interfaces

### `PaymentReliabilityStore`

**Purpose:** Durable payment operations, provider evidence, seller connections, marketplace units, reconciliation attempts, and claim/lease fields.

**You implement** this interface against your database (Postgres, etc.). The module calls it from lifecycle services, `WebhookProcessingService`, `ReconciliationService`, and `PaymentRecoveryService`.

Expectations include:

- Idempotent operation creation keyed by idempotency scope/key
- Evidence uniqueness on `(providerCode, accountRef, environment, providerEventId)`
- Atomic claim/lease updates for recovery (`claimPendingEvidence`) and checkout create execution leases
- Persistence of `consumerDeliveryStatus`, attempts, and last error on evidence rows

`MemoryPaymentReliabilityStore` is exported for **tests and local experiments only** — not durable production storage.

For the full method list, see the `PaymentReliabilityStore` interface in the package types and `AGENTS.md`.

### `PaymentEventConsumer`

**Purpose:** After webhook evidence is **verified** and **processed**, deliver a compact `VerifiedProcessedPaymentEvent` into your domain.

**You implement** `deliver(event)` with **idempotent** projections (same evidence may be retried).

The module sets `consumerDeliveryStatus` to `pending` when business delivery is still required. **`PaymentRecoveryService`** invokes `consumer.deliver` during recovery when delivery is not `confirmed`. Failed delivery records sanitized errors on the evidence row for retry.

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
Consumer HTTP endpoint
  → WebhookProcessingService.receiveWebhook
  → verify() callback (PaypalWebhookVerifier)
  → evidence persisted (idempotent by providerEventId)
  → lifecycle / transition processing on stored payload
  → consumerDeliveryStatus pending when business delivery is required
  → PaymentRecoveryService + PaymentEventConsumer (delivery acknowledgement)
```

**Consumer-owned:** TLS termination, route, authentication, reading raw body, PayPal transmission headers, calling `verify`.

**Module behavior:**

- Duplicate deliveries with the same `providerEventId` are idempotent.
- Incomplete duplicates may resume via `classifyWebhookEvidenceResume` / `reprocessStoredWebhookEvidence` (see tests).
- Verification failures classify into retryable unavailable vs terminal rejection (`VerifyWebhookResult.failureKind`).
- Operational error strings are sanitized before persistence where applicable.

```ts
import { WebhookProcessingService } from '@idevconn/payment-providers';
import { buildPaypalWebhookVerifier } from '@idevconn/payment-providers/paypal';

// store, runtime, config constructed as in quick-start
const webhooks = new WebhookProcessingService(store);
const verifier = buildPaypalWebhookVerifier({ runtime, nodeEnv: process.env.NODE_ENV });

export async function handlePayPalWebhook(req: IncomingMessage) {
  const rawBody = await readRawBody(req);
  const headers = parsePayPalHeaders(req);

  return webhooks.receiveWebhook({
    providerCode: runtime.context.providerCode,
    accountRef: runtime.context.accountRef,
    applicationRef: runtime.context.applicationRef,
    environment: runtime.context.environment,
    rawBody,
    providerEventId: headers.transmissionId,
    verify: () =>
      verifier.verify({
        webhookId: config.credentials!.webhookId!,
        headers,
        rawBody,
      }),
  });
}
```

After `processingStatus: 'processed'`, run or schedule **`PaymentRecoveryService.recover`** (with `PaymentEventConsumer` wired) to perform delivery and persist `consumerDeliveryStatus: 'confirmed'`.

---

## Recovery

`PaymentRecoveryService` supports:

- **Batch recovery** — `recover({ workerId, environment, limit?, leaseMs?, evidenceIds?, providerCode?, accountRef? })`
- **Single evidence** — `recoverEvidence({ evidenceId, workerId, environment, leaseMs? })`
- **Claim/lease** — uses `store.claimPendingEvidence` before work; lease cleared in `finally`
- **Summary counters** — `claimed`, `verified`, `processed`, `delivered`, `skipped`, `failed`

Recovery paths include reprocessing stored webhook evidence when verification already succeeded but processing or delivery did not complete, and **delivery-only retry** when processing succeeded but `consumerDeliveryStatus !== 'confirmed'`.

**Known limitation:** Evidence with `verificationStatus === 'pending'` is **not** re-verified by the recovery worker and is counted as **skipped**. Those rows require the appropriate **webhook redelivery** or consumer-driven verification path — do not assume recovery will complete PayPal signature verification.

Helpers: `isRecoverableEvidenceRow`, `classifyWebhookEvidenceResume` (exported from root).

---

## Errors and security

- Branch on **structured codes** (`PAYMENT_RELIABILITY_ERROR`, `PaymentReliabilityError`, `classifyPaymentFailure`, `toPublicFailure`, `resolveProviderFailure`) — not substring matching on error messages.
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
- [ ] Expose webhook HTTP transport and verify raw body integrity
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
