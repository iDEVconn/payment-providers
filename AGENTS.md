# @idevconn/payment-providers — consumer integration contract

## Document status and authority

This document describes the **current standalone module contract** for integrating `@idevconn/payment-providers` into a consumer backend.

- **Technical authority:** exported TypeScript types, interfaces, classes, and constants in `src/contracts`, `src/core`, and `src/paypal` (and their built `dist/*.d.ts` declarations after `npm run build`). When this document and source disagree, **source wins** — agents must inspect actual exports before changing integration behavior.
- **What this package is:** a reusable payment **command engine** and PayPal adapter. It is **not** a complete payment application, HTTP service, database, or admin product.
- **What agents must not assume:** missing application-specific behavior (entitlements, seller CRM, admin UI, HTTP routes) is **not automatically a module defect** until classified using the taxonomy in [Agent rules](#agent-rules).

**Supported package entry points (only documented surfaces):**

| Entry | Contents |
| --- | --- |
| `@idevconn/payment-providers` | Contracts (`src/contracts`) + core engine (`src/core`) |
| `@idevconn/payment-providers/paypal` | PayPal provider implementation (`src/paypal`) |

---

## Consumer integration architecture

### Command path (financial + reliability)

```text
Consumer command entry point (HTTP/RPC/job)
        |
        v
Consumer application facade (composition root)
        |
        v
@idevconn/payment-providers engine
        |
        +--> Consumer PaymentReliabilityStore (persistence port)
        +--> Consumer PaymentEventConsumer (business projection port)
        +--> Configured payment provider (PayPal executors / verify client)
```

- The **module** owns reusable payment command behavior: operation lifecycle, evidence inbox, webhook processing, recovery orchestration, provider executors, and reliability error semantics.
- The **consumer** owns application persistence adapters, HTTP/RPC transport, secrets loading, business projections, admin/query APIs, and product-specific rules.
- **Admin/read queries** must **not** be implemented by calling command lifecycle services as a query layer. Use store list helpers (for example `listProviderEvidenceForRecovery`) from a **consumer query adapter**.
- **Consumer commands** must **not** bypass the module lifecycle engine for provider-backed payment operations that the module already orchestrates (webhook inbox, recovery, checkout/payout/subscription/marketplace/seller services).

### Read path (admin / reporting)

```text
Consumer UI / Admin
        |
        v
Consumer query API
        |
        v
Consumer persistence / query adapter
        (implements PaymentReliabilityStore read paths or DB views)
```

The module exports `toPaymentEvidenceAdminView` and `PaymentEvidenceAdminView` for mapping stored evidence into admin DTOs. It does **not** expose HTTP controllers.

---

## Explicit configuration model

The module accepts **explicit typed configuration only**. It does **not** read `process.env`, load `.env` files, discover host configuration paths, or expose EnvGetter-based APIs. The consumer backend loads and validates secrets and passes `PaymentProviderConfig`.

Provider `sandbox` / `live` is a **domain configuration value** (which PayPal API environment to call), not host env handling inside this package.

Credentials must **never** be passed from browser code.

### `PaymentProviderConfig` (type)

Defined in `src/core/lib/payment-provider-config.ts`, exported from `@idevconn/payment-providers`.

| Field | Type | Required | Sensitive | Owner | Meaning |
| --- | --- | ---: | ---: | --- | --- |
| `environment` | `'sandbox' \| 'live'` | yes | no | Consumer | PayPal API environment for provider calls |
| `providerCode` | `string` | no | no | Consumer | Defaults to `'paypal'` in runtime resolution when omitted |
| `accountRef` | `string` | no | no | Consumer | Logical account scope; defaults to `'default'` |
| `applicationRef` | `string` | **yes** | no | Consumer | Application tenant ref; **required** — `resolvePaymentRuntime` throws `PaymentConfigurationError` when missing or empty |
| `credentials.clientId` | `string` | no* | **yes** | Consumer (server) | PayPal REST client id |
| `credentials.clientSecret` | `string` | no* | **yes** | Consumer (server) | PayPal REST client secret |
| `credentials.webhookId` | `string` | no | no | Consumer | PayPal webhook id used in signature verification |
| `credentials.requestTimeoutMs` | `number` | no | no | Consumer | HTTP timeout hint for provider clients |
| `capabilityFlags.checkout` | `boolean` | no | no | Consumer | Enable checkout capability evaluation (default enabled when unset) |
| `capabilityFlags.refund` | `boolean` | no | no | Consumer | Enable refund capability |
| `capabilityFlags.payout` | `boolean` | no | no | Consumer | Enable payout capability |
| `capabilityFlags.subscription` | `boolean` | no | no | Consumer | Enable subscription capability (default enabled when unset) |
| `capabilityFlags.seller_onboarding` | `boolean` | no | no | Consumer | Enable seller onboarding capability |
| `capabilityFlags.marketplace_checkout` | `boolean` | no | no | Consumer | Enable marketplace checkout capability |
| `partner.merchantId` | `string` | no | no | Consumer | PayPal partner merchant id (seller/marketplace flows) |
| `partner.attributionId` | `string` | no | no | Consumer | Partner attribution header value |
| `partner.sellerOnboardingReturnUrl` | `string` | no | no | Consumer | Seller onboarding return URL |
| `partner.sellerOnboardingProducts` | `string[]` | no | no | Consumer | Seller onboarding product list |
| `partner.sellerOnboardingFeatures` | `string[]` | no | no | Consumer | Seller onboarding feature list |
| `marketplaceSellerReadinessMaxAgeMs` | `number` | no | no | Consumer | Max age for seller readiness checks when marketplace is enabled in production |

\*Required for **ready** PayPal capabilities that need credentials; `evaluateCapabilities` / `resolvePaymentRuntime` report readiness separately.

### Configuration helpers (PayPal subpath)

| Export | Purpose |
| --- | --- |
| `parsePaypalEnvironment(value)` | Parse consumer-supplied string to `'sandbox' \| 'live'` |
| `buildNormalizedDeployedPaymentConfig({ providerEnvironment, ... })` | Build `NormalizedDeployedPaymentConfig` from explicit fields |
| `resolvePaymentRuntime({ config, nodeEnv?, executionStatus? })` | Resolve `ResolvedPaymentRuntime` + capability descriptor |
| `createPaypalPaymentProvider({ config, nodeEnv?, executionStatus? })` | Construct `PaypalPaymentProvider` |

### Minimal configuration example (consumer composition root)

```typescript
import {
  resolvePaymentRuntime,
  type PaymentProviderConfig,
} from '@idevconn/payment-providers';
import { createPaypalPaymentProvider } from '@idevconn/payment-providers/paypal';

// Consumer loads secrets from its own secret manager / env — not inside the module.
const config: PaymentProviderConfig = {
  providerCode: 'paypal',
  accountRef: 'default',
  applicationRef: 'my-app',
  environment: 'sandbox',
  credentials: {
    clientId: process.env.PAYPAL_CLIENT_ID!, // consumer-owned loading
    clientSecret: process.env.PAYPAL_CLIENT_SECRET!,
    webhookId: process.env.PAYPAL_WEBHOOK_ID,
    requestTimeoutMs: 30_000,
  },
  capabilityFlags: {
    checkout: true,
    subscription: true,
    payout: false,
    seller_onboarding: false,
    marketplace_checkout: false,
  },
};

const runtime = resolvePaymentRuntime({ config, nodeEnv: process.env.NODE_ENV });
const paypal = createPaypalPaymentProvider({ config, nodeEnv: process.env.NODE_ENV });
```

---

## Execution-mode API

Source: `src/contracts/lib/execution-mode.ts`, `src/core/lib/resolve-payment-execution-mode.ts`, `src/core/lib/payment-execution-config-adapter.ts`, `src/paypal/lib/deployed-paypal-config.ts`.

### Models

**`NormalizedDeployedPaymentConfig`** (consumer assembles at composition root)

| Field | Type | Required | Creator | Consumer use |
| --- | --- | ---: | --- | --- |
| `nodeEnv` | `string` | yes | Consumer | Drives production safety (`production` forbids simulation) |
| `providerEnvironment` | `'sandbox' \| 'live' \| null` | yes* | Consumer (after `parsePaypalEnvironment`) | Feeds execution mode derivation |
| `providerEnvironmentInvalid` | `boolean` | no | Consumer | Set when env string present but invalid |
| `financialSimulation` | `boolean` | no | Consumer test harness only | Forces simulation mode when `true` |
| `legacyPaymentExecutionMode` | `string \| null` | no | Consumer (legacy detection) | Conflict detection only |
| `legacyPaymentDeploymentEnvironment` | `string \| null` | no | Consumer | Conflict detection only |
| `legacyFundingSimulation` | `string \| null` | no | Consumer | Conflict detection only |

\*May be `null` when unset/invalid; `resolvePaymentExecutionMode` then sets `runtimeState: 'forbidden'`.

**`PaymentExecutionStatus`** (output of `resolvePaymentExecutionMode`; secret-free)

| Field | Type | Meaning |
| --- | --- | --- |
| `executionMode` | `'simulation' \| 'sandbox' \| 'live' \| null` | Resolved mode |
| `deploymentEnvironment` | `'local' \| 'ci' \| 'staging' \| 'live' \| null` | Derived deployment bucket |
| `runtimeState` | `'configured' \| 'unconfigured' \| 'conflict' \| 'forbidden'` | Whether provider/simulation calls allowed |
| `providerCallsEnabled` | `boolean` | `true` when configured sandbox/live |
| `simulatedExecutionEnabled` | `boolean` | `true` when configured simulation |
| `source` | `'provider-environment' \| 'explicit' \| 'legacy-alias' \| 'unconfigured' \| 'test-simulation'` | Provenance |
| `issues` | `{ code: PaymentExecutionIssueCode }[]` | Structured issues (no secrets) |

**`PaymentExecutionIssueCode`:** `MISSING_PROVIDER_ENVIRONMENT`, `INVALID_PROVIDER_ENVIRONMENT`, `MISSING_DEPLOYMENT_ENVIRONMENT`, `INVALID_DEPLOYMENT_ENVIRONMENT`, `MISSING_EXECUTION_MODE`, `INVALID_EXECUTION_MODE`, `DEPLOYMENT_MODE_FORBIDDEN`, `LEGACY_ALIAS_CONFLICT`, `LEGACY_ALIAS_FORBIDDEN_IN_LIVE`, `PAYPAL_ENVIRONMENT_MISMATCH`, `EXECUTION_MODE_MISMATCH`, `SIMULATION_FORBIDDEN_IN_PRODUCTION`.

**`PaymentExecutionContext`** (trusted server stamp for internal financial RPC envelopes)

| Field | Type | Required |
| --- | --- | ---: |
| `executionMode` | `PaymentExecutionMode` | yes |
| `deploymentEnvironment` | `PaymentDeploymentEnvironment` | yes |
| `applicationRef` | `string` | yes |

Built by **`buildPaymentExecutionContext(config: ResolvedPaymentExecutionConfig)`** when status is configured; returns `null` otherwise.

**`PaymentExecutionRequest<T>` / `PaymentExecutionPayload<T>`:** optional envelope adding `executionContext` to command payloads (`contracts/lib/execution-mode.ts`).

### Functions

| Export | Input | Output | Direct consumer call? |
| --- | --- | --- | --- |
| `buildNormalizedDeployedPaymentConfig(input)` | explicit fields (paypal subpath) | `NormalizedDeployedPaymentConfig` | **Yes** — composition root |
| `resolvePaymentExecutionMode(normalized)` | `NormalizedDeployedPaymentConfig` | `PaymentExecutionStatus` | **Yes** — startup / health |
| `resolvePaymentExecutionConfig(input)` | `PaymentExecutionConfigAdapterInput` | `ResolvedPaymentExecutionConfig` | **Yes** — startup adapter |
| `buildPaymentExecutionContext(resolved)` | `ResolvedPaymentExecutionConfig` | `PaymentExecutionContext \| null` | **Yes** — when stamping RPCs |
| `executionStatusDisplayLabel`, `shouldAbortPaymentStartup`, `isLiveSafetyViolation` | status / nodeEnv | helpers | Advanced startup |

**`PaymentExecutionConfigAdapterInput`:** `{ normalized, serviceLabel, applicationRef }` — `applicationRef` is **required** (same tenant id as `PaymentProviderConfig.applicationRef`).

**`ResolvedPaymentExecutionConfig`:** `{ status, displayLabel, applicationRef, normalized, startupBanner?, abortStartup }`.

### Composition order (relationship diagram)

```text
PaymentProviderConfig.environment          ──┐
parsePaypalEnvironment (consumer string)   ──┼──► buildNormalizedDeployedPaymentConfig
nodeEnv + legacy flags (consumer)          ──┘           │
                                                         ▼
                                              resolvePaymentExecutionMode
                                                         │
                                                         ▼
                                              PaymentExecutionStatus
                                                         │
                         ┌──────────────────────────────┼──────────────────────────────┐
                         ▼                              ▼                              ▼
              resolvePaymentRuntime          buildPaymentExecutionContext     PayPal factories
              ({ config, executionStatus,     (optional RPC stamp)            (executionStatus
               nodeEnv })                                                    kill-switch)
                         │
                         ▼
                 ResolvedPaymentRuntime
```

`PaymentProviderConfig.environment` is the **provider API target** (PayPal sandbox/live). `PaymentExecutionStatus.executionMode` is the **resolved execution policy** (simulation vs sandbox vs live) derived from normalized deploy config — they align when configured via `providerEnvironment` but serve different layers.

---

## Runtime resolution and composition

### `ResolvePaymentRuntimeInput`

| Field | Required | Provider |
| --- | ---: | --- |
| `config` | yes | Consumer |
| `nodeEnv` | no | Consumer |
| `executionStatus` | no | Consumer (from `resolvePaymentExecutionMode`) |

### `ResolvedPaymentRuntime`

| Field | Type | Meaning |
| --- | --- | --- |
| `mode` | `'live-provider' \| 'fake'` | Whether real PayPal credentials path or reject-only/fake |
| `context` | `PaymentAccountContext` | `{ providerCode, accountRef, environment, applicationRef }` |
| `descriptor` | `PaymentProviderDescriptor` | Capability rows + context |
| `configBanner` | `string` | Optional boxed configuration warning (non-secret) |
| `checkoutCredentials` | `{ clientId, clientSecret, environment, requestTimeoutMs? }` | Present when checkout creds configured |

### `PaymentRecoveryDependencies`

| Field | Required | Provider | Used by |
| --- | ---: | --- | --- |
| `store` | yes | Consumer | `PaymentRecoveryService` |
| `webhookProcessing` | yes | Consumer-composed | Reprocess + delivery paths |
| `consumer` | no | Consumer | Delivery acknowledgement; `null` skips delivery |

### `ReceiveWebhookInput`

| Field | Required | Provider |
| --- | ---: | --- |
| `providerCode`, `accountRef`, `applicationRef`, `environment` | yes | Consumer route |
| `providerEventId` | yes | Consumer (transmission id) |
| `rawBody` | yes | Consumer HTTP |
| `verify` | yes | Consumer callback → `VerifyWebhookResult` |

**`WebhookProcessingService` constructor:** `(store, subscriptionProviderLookup?)` where `WebhookSubscriptionProviderLookup = Pick<ReconciliationProviderLookup, 'getSubscription'>`.

### Wiring example

```typescript
import {
  resolvePaymentRuntime,
  resolvePaymentExecutionMode,
  WebhookProcessingService,
  PaymentRecoveryService,
  CheckoutLifecycleService,
  type PaymentProviderConfig,
} from '@idevconn/payment-providers';
import {
  buildNormalizedDeployedPaymentConfig,
  createPaypalPaymentProvider,
  buildPaypalCheckoutExecutor,
} from '@idevconn/payment-providers/paypal';

const normalized = buildNormalizedDeployedPaymentConfig({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  providerEnvironment: config.environment,
});
const executionStatus = resolvePaymentExecutionMode(normalized);
const runtime = resolvePaymentRuntime({ config, nodeEnv: normalized.nodeEnv, executionStatus });
const paypal = createPaypalPaymentProvider({ config, nodeEnv: normalized.nodeEnv, executionStatus });

const checkoutPort = buildPaypalCheckoutExecutor({
  runtime,
  strategyFactory: () => paypal.createCheckoutStrategy(),
  nodeEnv: normalized.nodeEnv,
  executionStatus,
});

const webhookProcessing = new WebhookProcessingService(store, checkoutPort);
const recovery = new PaymentRecoveryService({ store, webhookProcessing, consumer });
const checkout = new CheckoutLifecycleService(store, checkoutPort);
```

---

## Failure mapping (public)

| Export | Signature / role |
| --- | --- |
| `classifyPaymentFailure(input)` | `{ code?, message?, causeCode?, uncertain?, retryable?, providerAttempted? }` → `ClassifiedPaymentFailure` |
| `toPublicFailure(classified)` | strips `uncertain`, `retryable`, `diagnosticMessage` → `NormalizedPaymentFailure` |
| `resolveProviderFailure(error)` | unknown → `ResolvedProviderFailure` `{ code, message, uncertain, retryable, providerDebugId }` |
| `PaymentConfigurationError` | `{ missingFields: string[] }` — invalid PayPal factory/config |

**`NormalizedPaymentFailure` (RPC-safe):** `{ code, category, causeCode, nextAction }`.

**`ClassifiedPaymentFailure` adds:** `uncertain: boolean`, `retryable: boolean`, `diagnosticMessage: string` (server diagnostic — not customer copy).

### `PAYMENT_CAUSE_CODE` (from `PAYMENT_CAUSE_CODE` in `operation-result.ts`)

| `causeCode` | Typical `category` | `retryable` (classified) | Typical `nextAction` | Consumer action |
| --- | --- | ---: | --- | --- |
| `CHECKOUT_CREDENTIALS_MISSING` | `configuration` | no | `contact_support` | Fix credentials / capability config |
| `CAPABILITY_DISABLED` | `capability_disabled` | no | `contact_support` | Enable capability flag or disable feature |
| `EXECUTION_NOT_CONFIGURED` | `execution_policy` | no | `contact_support` | Fix execution/deploy config |
| `EXECUTION_MISMATCH` | `execution_policy` | no | `contact_support` | Align execution mode with deployment |
| `PROVIDER_AUTH_REJECTED` | `provider_authentication` | no | `contact_support` | Fix OAuth credentials |
| `PROVIDER_REJECTED` | `provider_rejection` | no | `start_new_attempt` | Fix request or mark operation failed |
| `PROVIDER_TIMEOUT` | `transport` | yes | `check_status` | Retry with idempotency; reconcile |
| `RESPONSE_LOST` | `transport` | yes | `check_status` | Reconcile provider state |
| `VALIDATION_FAILED` | `validation` | no | `none` | Fix caller input |
| `VERIFICATION_UNAVAILABLE` | `verification` | yes | `check_status` | Retry webhook / return 503 |
| `VERIFICATION_REJECTED` | `verification` | no | `none` | Reject webhook (400) |
| `PERSISTENCE_AFTER_SIDE_EFFECT` | `persistence` | uncertain | `check_status` | Reconcile; avoid duplicate provider calls |
| `TRANSPORT_BEFORE_PROVIDER` | `persistence` | yes | `retry_later` | Retry command |

**`classifyPaymentFailure` input:** `{ code?, message?, causeCode?, uncertain?, retryable?, providerAttempted? }` where `providerAttempted: true` steers persistence failures toward `PERSISTENCE_AFTER_SIDE_EFFECT`.

**`PaymentConfigurationError`:** thrown by PayPal factories on invalid explicit config; `{ name: 'PaymentConfigurationError', message, missingFields: string[] }` — terminal, fix composition root config (not retryable).

**Rules:** branch on `code`, `causeCode`, `category`, `nextAction`, and `PaymentReliabilityError.code` — **never** on raw `message` / `diagnosticMessage` text. Lifecycle results embed `NormalizedPaymentFailure` on `outcome: 'failed'` (`failure` field). Use `toPublicFailure` before RPC responses; keep `ClassifiedPaymentFailure.diagnosticMessage` server-side only.

---

## Named provider ports

PayPal **`Paypal*Executor`** classes implement these ports today. Another provider may implement the same port interfaces in the future.

### `CheckoutProviderPort`

| Method | Input | Output | Module caller | Implementation |
| --- | --- | --- | --- | --- |
| `createOrder` | `ExecuteCreateCheckoutOrderRequest` | `ExecuteCreateCheckoutOrderResult` | Checkout lifecycle / reconciliation | PayPal checkout executor |
| `getOrder` | `ExecuteGetCheckoutOrderRequest` | `ExecuteGetCheckoutOrderResult` | Checkout lifecycle / reconciliation | PayPal |
| `captureOrder` | `ExecuteCaptureCheckoutOrderRequest` | `ExecuteCaptureCheckoutOrderResult` | Checkout lifecycle | PayPal |
| `refundCapture` | `ExecuteRefundCaptureRequest` | `ExecuteRefundCaptureResult` | Checkout lifecycle | PayPal |
| `getRefund` | `ExecuteGetRefundRequest` | `ExecuteGetRefundResult` | Checkout lifecycle / reconciliation | PayPal |

### `PayoutProviderPort`

| Method | Input | Output | Module caller | Implementation |
| --- | --- | --- | --- | --- |
| `submitBatch` | `ExecuteSubmitPayoutBatchRequest` | `ExecuteSubmitPayoutBatchResult` | Payout lifecycle | PayPal payout executor |
| `getBatch` | `ExecuteGetPayoutBatchRequest` | `ExecuteGetPayoutBatchResult` | Payout lifecycle / reconciliation | PayPal |
| `getItem` | `ExecuteGetPayoutItemRequest` | `ExecuteGetPayoutItemResult` | Payout lifecycle / reconciliation | PayPal |
| `cancelUnclaimedItem` | `ExecuteCancelUnclaimedPayoutItemRequest` | `ExecuteCancelUnclaimedPayoutItemResult` | Payout lifecycle | PayPal |

### `SubscriptionProviderPort`

| Method | Input | Output |
| --- | --- | --- |
| `createProduct` | `ExecuteCreateCatalogProductRequest` | `ExecuteCreateCatalogProductResult` |
| `getProduct` | `ExecuteGetCatalogProductRequest` | `ExecuteGetCatalogProductResult` |
| `createPlan` | `ExecuteCreateBillingPlanRequest` | `ExecuteCreateBillingPlanResult` |
| `getPlan` | `ExecuteGetBillingPlanRequest` | `ExecuteGetBillingPlanResult` |
| `activatePlan` / `deactivatePlan` | `ExecutePlanLifecycleRequest` | `ExecutePlanLifecycleResult` |
| `createSubscription` | `ExecuteCreateSubscriptionRequest` | `ExecuteCreateSubscriptionResult` |
| `getSubscription` | `ExecuteGetSubscriptionRequest` | `ExecuteGetSubscriptionResult` |
| `cancelSubscription` / `suspendSubscription` / `activateSubscription` | `ExecuteSubscriptionLifecycleRequest` | `ExecuteSubscriptionLifecycleResult` |

### `SellerOnboardingProviderPort`

| Method | Input | Output |
| --- | --- | --- |
| `createReferral` | `ExecuteCreateSellerReferralRequest` | `ExecuteCreateSellerReferralResult` |
| `getReferral` | `ExecuteGetSellerReferralRequest` | `ExecuteGetSellerReferralResult` |
| `findMerchantByTrackingId` | `ExecuteFindSellerMerchantRequest` | `ExecuteFindSellerMerchantResult` |
| `getMerchantStatus` | `ExecuteGetSellerMerchantStatusRequest` | `ExecuteGetSellerMerchantStatusResult` |

### `MarketplaceProviderPort`

| Method | Input | Output |
| --- | --- | --- |
| `createOrder` | `ExecuteCreateMarketplaceOrderRequest` | `ExecuteCreateMarketplaceOrderResult` |
| `getOrder` | `ExecuteGetMarketplaceOrderRequest` | `ExecuteGetMarketplaceOrderResult` |
| `captureOrder` | `ExecuteCaptureMarketplaceOrderRequest` | `ExecuteCaptureMarketplaceOrderResult` |
| `refundUnit` | `ExecuteRefundMarketplaceUnitRequest` | `ExecuteRefundMarketplaceUnitResult` |
| `getRefund` | `ExecuteGetRefundRequest` | `ExecuteGetRefundResult` |

### `ReconciliationProviderLookup`

Defined in `src/core/lib/checkout-provider-port.ts`. PayPal executors implement this via combined checkout/payout/subscription/seller/marketplace executors or a consumer facade.

| Method | Input | Output |
| --- | --- | --- |
| `getOrder` | `ExecuteGetCheckoutOrderRequest` | `ExecuteGetCheckoutOrderResult` |
| `getRefund` | `ExecuteGetRefundRequest` | `ExecuteGetRefundResult` |
| `getPayoutBatch` | `ExecuteGetPayoutBatchRequest` | `ExecuteGetPayoutBatchResult` |
| `getPayoutItem` | `ExecuteGetPayoutItemRequest` | `ExecuteGetPayoutItemResult` |
| `getProduct` | `ExecuteGetCatalogProductRequest` | `ExecuteGetCatalogProductResult` |
| `getPlan` | `ExecuteGetBillingPlanRequest` | `ExecuteGetBillingPlanResult` |
| `getSubscription` | `ExecuteGetSubscriptionRequest` | `ExecuteGetSubscriptionResult` |
| `getReferral` | `ExecuteGetSellerReferralRequest` | `ExecuteGetSellerReferralResult` |
| `findMerchantByTrackingId` | `ExecuteFindSellerMerchantRequest` | `ExecuteFindSellerMerchantResult` |
| `getMerchantStatus` | `ExecuteGetSellerMerchantStatusRequest` | `ExecuteGetSellerMerchantStatusResult` |
| `getMarketplaceOrder` | `ExecuteGetMarketplaceOrderRequest` | `ExecuteGetMarketplaceOrderResult` |

### `WebhookSubscriptionProviderLookup`

`Pick<ReconciliationProviderLookup, 'getSubscription'>` — optional webhook processing dependency for subscription webhook ordering.

---

## PayPal factory inputs and partner mapping

**`PaymentProviderConfig.partner`** is consumer configuration storage. PayPal factories require **`partnerConfig`** objects — the composition root maps between them (no automatic mapping in the module).

```text
PaymentProviderConfig.partner
        |
        | consumer composition mapping (required)
        v
PaypalSellerOnboardingPartnerConfig / PaypalMarketplacePartnerConfig
        |
        v
buildPaypalSellerOnboardingExecutor({ partnerConfig, runtime, ... })
buildPaypalMarketplaceExecutor({ partnerConfig, runtime, ... })
```

**`PaypalSellerOnboardingPartnerConfig`:** `{ partnerMerchantId, partnerAttributionId, returnUrl, products: string[], features: string[] }` — all required strings/arrays at factory time.

**`PaypalMarketplacePartnerConfig`:** `{ partnerAttributionId: string }`.

**`BuildPaypalSellerOnboardingExecutorInput`:** `{ runtime, partnerConfig, nodeEnv?, executionStatus?, forceFakeHttp?, httpClient? }`.

**`BuildPaypalMarketplaceExecutorInput`:** `{ runtime, partnerConfig, nodeEnv?, executionStatus?, forceFakeHttp?, httpClient? }`.

**`BuildPaypalCheckoutExecutorInput`:** `{ runtime, strategyFactory, nodeEnv?, executionStatus?, forceFakeHttp? }` — no `partnerConfig`.

```typescript
import type { PaymentProviderConfig } from '@idevconn/payment-providers';
import type { PaypalSellerOnboardingPartnerConfig } from '@idevconn/payment-providers/paypal';

function mapSellerPartner(config: PaymentProviderConfig): PaypalSellerOnboardingPartnerConfig {
  const p = config.partner;
  return {
    partnerMerchantId: p?.merchantId ?? '',
    partnerAttributionId: p?.attributionId ?? '',
    returnUrl: p?.sellerOnboardingReturnUrl ?? '',
    products: p?.sellerOnboardingProducts ?? [],
    features: p?.sellerOnboardingFeatures ?? [],
  };
}
```

---

## Reconciliation API

**`ReconciliationService`:** `constructor(store, providerLookup: ReconciliationProviderLookup)`.

**`reconcile(limit?: number)`** — default `limit = 25`. **Does not accept `workerId`.**

**`ReconcilePaymentOperationsResult`:**

| Field | Meaning |
| --- | --- |
| `examined` | Evidence + uncertain operations + seller connections considered |
| `applied` | Successful state applications |
| `retryableFailures` | Failures recorded as retryable |
| `terminalFailures` | Terminal reconciliation failures |
| `noOps` | No state change |

Store methods used: `listReconciliationCandidates`, `listUncertainOperations`, `listSellerConnectionsForReconciliation`, `insertReconciliationAttempt`, operation/evidence updates.

**`ReconcilePaymentOperationsRequest`** (`contracts/lib/webhook.ts`): `{ limit?: number; workerId?: string }`.

**Classification:** **`NOT USED BY CURRENT SERVICE`** — exported DTO for RPC/gateway contracts; `ReconciliationService.reconcile` only accepts numeric `limit`. Do not pass `workerId` to the service method.

---

## Seller and marketplace store models

The module persists **provider-aligned seller connection state** and **marketplace purchase units** through `PaymentReliabilityStore`. Consumer **business seller profiles** (CRM, KYC UX, user linkage) remain consumer-owned; link via `sellerRef` / `applicationRef`.

### `SellerConnectionRecord` fields

| Field | Type | Owner | Notes |
| --- | --- | --- | --- |
| `connectionId` | `string` | Store | Primary key |
| `applicationRef`, `providerCode`, `accountRef`, `environment` | strings | Consumer context | Scope |
| `sellerRef` | `string` | Consumer | Business seller id |
| `trackingId` | `string` | Module/consumer | Onboarding tracking; uniqueness consumer-enforced |
| `latestReferralOperationId` | `string \| null` | Module | Links referral operation |
| `providerReferralId`, `providerMerchantId` | `string \| null` | Provider | PayPal ids |
| `connectionStatus` | `SellerConnectionStatus` | Module lifecycle | See contracts |
| `consentStatus` | `SellerConsentStatus` | Module | |
| `paymentsReceivable`, `primaryEmailConfirmed`, `requiredPermissionsGranted` | `boolean \| null` | Provider snapshot | |
| `onboardingCompleted`, `restricted`, `readinessReady` | `boolean` | Module | |
| `readinessReasons` | `string[]` | Module | |
| `normalizedCapabilities` | `Record<string, boolean>` | Module | |
| `version`, `createdAt`, `updatedAt` | | Store | Optimistic concurrency |

**Store methods:** `createSellerConnection`, `findSellerConnectionById`, `findSellerConnectionBySellerRef`, `findSellerConnectionByMerchantId`, `findSellerConnectionByReferralId`, `findSellerConnectionByTrackingId`, `updateSellerConnection`, `listSellerConnectionsForReconciliation`.

**`CreateSellerConnectionInput`:** `{ applicationRef, providerCode, accountRef, environment, sellerRef, trackingId, latestReferralOperationId?, providerReferralId? }`.

**`UpdateSellerConnectionInput`:** `{ connectionId, expectedVersion, ...partial fields }` — see `contracts/lib/seller-onboarding.ts`.

### `MarketplacePurchaseUnitRecord` fields

| Field | Type | Notes |
| --- | --- | --- |
| `unitId` | `string` | Primary key |
| `operationId` | `string` | Parent marketplace operation |
| `referenceId` | `string` | Unit reference in order |
| `sellerRef` | `string` | Consumer seller link |
| `providerMerchantId` | `string \| null` | PayPal merchant |
| `amountMinor`, `currencyCode` | `string` | **Integer minor units as decimal string** (not major units) |
| `platformFeeMinor`, `platformFeeCurrency` | `string \| null` | Optional platform fee |
| `unitStatus` | `MarketplaceUnitStatus` | Lifecycle |
| `providerCaptureId`, fee/net/refund fields | | Provider reconciliation |
| `version`, timestamps | | Concurrency |

**Store methods:** `insertMarketplacePurchaseUnits`, `listMarketplacePurchaseUnits`, `findMarketplacePurchaseUnitById`, `findMarketplacePurchaseUnitByReference`, `findMarketplacePurchaseUnitByCaptureId`, `updateMarketplacePurchaseUnit`.

**`InsertMarketplacePurchaseUnitInput`:** `{ operationId, referenceId, sellerRef, providerMerchantId, amountMinor, currencyCode, platformFeeMinor?, platformFeeCurrency?, unitStatus? }`.

---

## Lifecycle command DTOs and services

**Money:** `CanonicalMoney = { currency: string, amountMinor: string }` — amount is **minor units encoded as a decimal string** (`contracts/lib/money.ts`).

**Shared contexts:** `CheckoutProviderContext`, `PayoutProviderContext`, `SubscriptionProviderContext`, `SellerOnboardingProviderContext` — each includes `{ providerCode, accountRef, applicationRef, environment }`.

### Service map

| Service method | Request DTO | Result DTO | Provider port | Store |
| --- | --- | --- | --- | --- |
| `CheckoutLifecycleService.createCheckoutOrder` | `CreateCheckoutOrderRequest` | `CheckoutOrderResult` | `CheckoutProviderPort` | operations |
| `CheckoutLifecycleService.retryCheckoutOrder` | `RetryCheckoutOrderRequest` | `CheckoutOrderResult` | checkout | operations |
| `CheckoutLifecycleService.getCheckoutOrder` | `GetCheckoutOrderRequest` | `CheckoutOrderResult` | checkout | operations |
| `CheckoutLifecycleService.captureCheckoutOrder` | `CaptureCheckoutOrderRequest` | `CheckoutCaptureResult` | checkout | operations |
| `CheckoutLifecycleService.refundCapture` | `RefundCaptureRequest` | `RefundCaptureResult` | checkout | operations |
| `PayoutLifecycleService.submitPayoutBatch` | `SubmitPayoutBatchRequest` | `SubmitPayoutBatchResult` | `PayoutProviderPort` | operations |
| `PayoutLifecycleService.getPayoutBatch` | `GetPayoutBatchRequest` | `GetPayoutBatchResult` | payout | operations |
| `PayoutLifecycleService.getPayoutItem` | `GetPayoutItemRequest` | `GetPayoutItemResult` | payout | operations |
| `PayoutLifecycleService.cancelUnclaimedPayoutItem` | `CancelUnclaimedPayoutItemRequest` | `CancelUnclaimedPayoutItemResult` | payout | operations |
| `SubscriptionLifecycleService.createCatalogProduct` | `CreateCatalogProductRequest` | `CatalogProductResult` | `SubscriptionProviderPort` | operations |
| `SubscriptionLifecycleService.getCatalogProduct` | `GetCatalogProductRequest` | `GetCatalogProductResult` | subscription | operations |
| `SubscriptionLifecycleService.createBillingPlan` | `CreateBillingPlanRequest` | `BillingPlanResult` | subscription | operations |
| `SubscriptionLifecycleService.getBillingPlan` | `GetBillingPlanRequest` | `GetBillingPlanResult` | subscription | operations |
| `SubscriptionLifecycleService.activateBillingPlan` / `deactivateBillingPlan` | `PlanLifecycleRequest` | `PlanLifecycleResult` | subscription | operations |
| `SubscriptionLifecycleService.createSubscription` | `CreateSubscriptionRequest` | `SubscriptionResult` | subscription | operations |
| `SubscriptionLifecycleService.getSubscription` | `GetSubscriptionRequest` | `GetSubscriptionResult` | subscription | operations |
| `SubscriptionLifecycleService.retrySubscriptionCreate` | `RetrySubscriptionCreateRequest` | `SubscriptionResult` | subscription | operations |
| `SubscriptionLifecycleService.cancelSubscription` / `suspendSubscription` / `activateSubscription` | `SubscriptionLifecycleCommandRequest` | `SubscriptionLifecycleCommandResult` | subscription | operations |
| `MarketplaceLifecycleService.createMarketplaceOrder` | `CreateMarketplaceOrderRequest` | `MarketplaceOrderResult` | `MarketplaceProviderPort` | operations + units |
| `MarketplaceLifecycleService.getMarketplaceOrder` | `GetMarketplaceOrderRequest` | `MarketplaceOrderResult` | marketplace | operations |
| `MarketplaceLifecycleService.captureMarketplaceOrder` | `CaptureMarketplaceOrderRequest` | `MarketplaceOrderResult` | marketplace | operations + units |
| `MarketplaceLifecycleService.refundMarketplaceUnit` | `RefundMarketplaceUnitRequest` | `RefundMarketplaceUnitResult` | marketplace | operations + units |
| `SellerOnboardingLifecycleService.createSellerReferral` | `CreateSellerReferralRequest` | `SellerReferralResult` | `SellerOnboardingProviderPort` | operations + seller connection |
| `SellerOnboardingLifecycleService.getSellerReferral` | `GetSellerReferralRequest` | `SellerReferralResult` | seller | operations |
| `SellerOnboardingLifecycleService.getSellerConnection` | `GetSellerConnectionRequest` | `SellerConnectionResult` | store read | seller connection |
| `SellerOnboardingLifecycleService.reconcileSellerConnection` | `ReconcileSellerConnectionRequest` | `ReconcileSellerConnectionResult` | seller + store | seller connection |

### DTO field tables (complete inline reference)

Column semantics: **Producer** creates the field value; **Consumer** reads or persists it. **Required** means the field must be present when sending that DTO shape (optional properties may be omitted).

#### Shared provider contexts

#### `CheckoutProviderContext`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |


#### `PayoutProviderContext`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |


#### `SubscriptionProviderContext`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |


#### `SellerOnboardingProviderContext`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |



### `checkout.ts`

#### `CreateCheckoutOrderRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `idempotencyKey` | `string` | yes | Consumer caller | Module store | Command deduplication key within idempotency scope. |
| `correlationId` | `string \| null` | no | Consumer caller | Module store | Optional consumer tracing reference stored on the operation. |
| `amount` | `CanonicalMoney` | yes | Consumer caller | Module lifecycle | Field `amount` on this DTO (see source semantics). |
| `referenceId` | `string \| null` | no | Consumer caller | Module lifecycle | Field `referenceId` on this DTO (see source semantics). |
| `returnUrl` | `string \| null` | no | Consumer caller | Module lifecycle | Field `returnUrl` on this DTO (see source semantics). |
| `cancelUrl` | `string \| null` | no | Consumer caller | Module lifecycle | Field `cancelUrl` on this DTO (see source semantics). |

#### `GetCheckoutOrderRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `providerOrderId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerOrderId` on this DTO (see source semantics). |
| `checkoutOperationId` | `string \| null` | no | Module lifecycle | Module lifecycle | Field `checkoutOperationId` on this DTO (see source semantics). |

#### `RetryCheckoutOrderRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `checkoutOperationId` | `string` | yes | Module lifecycle | Module lifecycle | Field `checkoutOperationId` on this DTO (see source semantics). |
| `amount` | `CanonicalMoney` | yes | Consumer caller | Module lifecycle | Field `amount` on this DTO (see source semantics). |
| `referenceId` | `string \| null` | no | Consumer caller | Module lifecycle | Field `referenceId` on this DTO (see source semantics). |
| `returnUrl` | `string \| null` | no | Consumer caller | Module lifecycle | Field `returnUrl` on this DTO (see source semantics). |
| `cancelUrl` | `string \| null` | no | Consumer caller | Module lifecycle | Field `cancelUrl` on this DTO (see source semantics). |

#### `CaptureCheckoutOrderRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `idempotencyKey` | `string` | yes | Consumer caller | Module store | Command deduplication key within idempotency scope. |
| `correlationId` | `string \| null` | no | Consumer caller | Module store | Optional consumer tracing reference stored on the operation. |
| `checkoutOperationId` | `string` | yes | Module lifecycle | Module lifecycle | Field `checkoutOperationId` on this DTO (see source semantics). |
| `providerOrderId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerOrderId` on this DTO (see source semantics). |

#### `CheckoutOrderResult`

Discriminated union on `outcome` (`PaymentResultOutcome`). All variants include the base fields below; additional fields depend on `outcome`.

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `operationId` | `string` | yes | Module lifecycle | Consumer caller | Persisted checkout operation id. |
| `operationKind` | `'checkout'` | yes | Module lifecycle | Consumer caller | Always `checkout`. |
| `operationStatus` | `PaymentOperationStatus` | yes | Module lifecycle | Consumer caller | Durable operation status in store. |
| `providerOrderId` | `string \| null` | yes | Module / provider | Consumer caller | PayPal order id when known. |
| `checkoutStatus` | `CheckoutOrderStatus` | yes | Module lifecycle | Consumer caller | Checkout-specific status snapshot. |
| `amount` | `CanonicalMoney` | yes | Module lifecycle | Consumer caller | Order amount (minor units string). |
| `approvalUrl` | `string \| null` | yes | Module lifecycle | Consumer caller | PayPal approval URL when action required. |
| `correlationId` | `string \| null` | yes | Module lifecycle | Consumer caller | Echo of request correlation id. |
| `providerDebugId` | `string \| null` | no | Provider adapter | Consumer logs | PayPal debug id when returned. |
| `outcome` | `PaymentResultOutcome` | yes | Module lifecycle | Consumer caller | `requires_action`, `pending`, `succeeded`, `failed`, or `unknown`. |
| `nextAction` | `PaymentNextAction` | yes | Module lifecycle | Consumer caller | Guidance for caller (not authorization). |
| `failure` | `NormalizedPaymentFailure` | when `outcome: 'failed'` | Module lifecycle | Consumer caller | Public-safe failure; branch on codes not messages. |
| `uncertaintyReason` | `string` | when `outcome: 'unknown'` | Module lifecycle | Consumer caller | Operator-safe uncertainty explanation. |

#### `CheckoutCaptureResult`

Discriminated union on `outcome`. Base fields apply to all variants.

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `operationId` | `string` | yes | Module lifecycle | Consumer caller | Capture operation id. |
| `operationKind` | `'capture'` | yes | Module lifecycle | Consumer caller | Always `capture`. |
| `operationStatus` | `PaymentOperationStatus` | yes | Module lifecycle | Consumer caller | Durable operation status. |
| `checkoutOperationId` | `string` | yes | Module lifecycle | Consumer caller | Parent checkout operation id. |
| `providerOrderId` | `string` | yes | Module lifecycle | Consumer caller | PayPal order id. |
| `providerCaptureId` | `string \| null` | yes | Module / provider | Consumer caller | PayPal capture id when known. |
| `captureStatus` | `CheckoutOrderStatus` | yes | Module lifecycle | Consumer caller | Capture status snapshot. |
| `amount` | `CanonicalMoney \| null` | yes | Module lifecycle | Consumer caller | Captured amount when known. |
| `correlationId` | `string \| null` | yes | Module lifecycle | Consumer caller | Echo of request correlation id. |
| `providerDebugId` | `string \| null` | no | Provider adapter | Consumer logs | PayPal debug id when returned. |
| `outcome` | `PaymentResultOutcome` | yes | Module lifecycle | Consumer caller | Result discriminator. |
| `nextAction` | `PaymentNextAction` | yes | Module lifecycle | Consumer caller | Guidance for caller. |
| `failure` | `NormalizedPaymentFailure` | when `outcome: 'failed'` | Module lifecycle | Consumer caller | Public-safe failure payload. |
| `uncertaintyReason` | `string` | when `outcome: 'unknown'` | Module lifecycle | Consumer caller | Operator-safe uncertainty explanation. |
| `approvalUrl` | `string \| null` | when `outcome: 'requires_action'` | Module lifecycle | Consumer caller | Optional approval URL on requires_action variant. |

#### `ExecuteCreateCheckoutOrderRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `providerRequestId` | `string` | yes | Provider adapter / module | Provider port implementation | Module-generated idempotency token for a single provider HTTP attempt. |
| `amount` | `CanonicalMoney` | yes | Consumer caller | Module lifecycle | Field `amount` on this DTO (see source semantics). |
| `referenceId` | `string \| null` | no | Consumer caller | Module lifecycle | Field `referenceId` on this DTO (see source semantics). |
| `returnUrl` | `string \| null` | no | Consumer caller | Module lifecycle | Field `returnUrl` on this DTO (see source semantics). |
| `cancelUrl` | `string \| null` | no | Consumer caller | Module lifecycle | Field `cancelUrl` on this DTO (see source semantics). |

#### `ExecuteCreateCheckoutOrderResult`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerOrderId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerOrderId` on this DTO (see source semantics). |
| `checkoutStatus` | `CheckoutOrderStatus` | yes | Consumer caller | Module lifecycle | Field `checkoutStatus` on this DTO (see source semantics). |
| `approvalUrl` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `approvalUrl` on this DTO (see source semantics). |
| `amount` | `CanonicalMoney` | yes | Consumer caller | Module lifecycle | Field `amount` on this DTO (see source semantics). |
| `providerDebugId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerDebugId` on this DTO (see source semantics). |

#### `ExecuteGetCheckoutOrderRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `providerOrderId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerOrderId` on this DTO (see source semantics). |

#### `ExecuteGetCheckoutOrderResult`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerOrderId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerOrderId` on this DTO (see source semantics). |
| `checkoutStatus` | `CheckoutOrderStatus` | yes | Consumer caller | Module lifecycle | Field `checkoutStatus` on this DTO (see source semantics). |
| `approvalUrl` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `approvalUrl` on this DTO (see source semantics). |
| `amount` | `CanonicalMoney \| null` | yes | Consumer caller | Module lifecycle | Field `amount` on this DTO (see source semantics). |
| `captureAmount` | `CanonicalMoney \| null` | yes | Consumer caller | Module lifecycle | Field `captureAmount` on this DTO (see source semantics). |
| `providerCaptureId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerCaptureId` on this DTO (see source semantics). |
| `providerCaptureStatus` | `CheckoutOrderStatus \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerCaptureStatus` on this DTO (see source semantics). |
| `providerDebugId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerDebugId` on this DTO (see source semantics). |

#### `ExecuteCaptureCheckoutOrderRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `providerRequestId` | `string` | yes | Provider adapter / module | Provider port implementation | Module-generated idempotency token for a single provider HTTP attempt. |
| `providerOrderId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerOrderId` on this DTO (see source semantics). |

### `evidence.ts`

#### `ProviderEvidence`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `evidenceId` | `string` | yes | Consumer caller | Module lifecycle | Field `evidenceId` on this DTO (see source semantics). |
| `providerCode` | `string` | yes | Consumer caller | Module persistence + reconciliation | Field `providerCode` on this DTO (see source semantics). |
| `accountRef` | `string` | yes | Consumer caller | Module lifecycle | Field `accountRef` on this DTO (see source semantics). |
| `applicationRef` | `string` | yes | Consumer caller | Module lifecycle | Field `applicationRef` on this DTO (see source semantics). |
| `environment` | `PaymentEnvironment` | yes | Consumer caller | Module lifecycle | Field `environment` on this DTO (see source semantics). |
| `evidenceKind` | `ProviderEvidenceKind` | yes | Consumer caller | Module lifecycle | Field `evidenceKind` on this DTO (see source semantics). |
| `providerEventId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerEventId` on this DTO (see source semantics). |
| `relatedOperationId` | `string \| null` | yes | Module lifecycle | Module lifecycle | Field `relatedOperationId` on this DTO (see source semantics). |
| `receivedAt` | `string` | yes | Consumer caller | Module lifecycle | Field `receivedAt` on this DTO (see source semantics). |
| `verificationStatus` | `EvidenceVerificationStatus` | yes | Consumer caller | Module lifecycle | Field `verificationStatus` on this DTO (see source semantics). |
| `payloadSha256` | `string` | yes | Consumer caller | Module lifecycle | Hash of rawPayload for integrity checks. |
| `processingStatus` | `EvidenceProcessingStatus` | yes | Consumer caller | Module lifecycle | Field `processingStatus` on this DTO (see source semantics). |
| `eventType` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `eventType` on this DTO (see source semantics). |
| `resourceId` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `resourceId` on this DTO (see source semantics). |
| `errorCode` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `errorCode` on this DTO (see source semantics). |
| `errorMessage` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `errorMessage` on this DTO (see source semantics). |
| `claimLeaseExpiresAt` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `claimLeaseExpiresAt` on this DTO (see source semantics). |
| `claimWorkerId` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `claimWorkerId` on this DTO (see source semantics). |
| `processedAt` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `processedAt` on this DTO (see source semantics). |
| `consumerDeliveryStatus` | `ConsumerDeliveryStatus` | no | Consumer caller | Module lifecycle | Field `consumerDeliveryStatus` on this DTO (see source semantics). |
| `consumerDeliveredAt` | `string \| null` | no | Consumer caller | Module lifecycle | Field `consumerDeliveredAt` on this DTO (see source semantics). |
| `consumerDeliveryAttempts` | `number` | no | Consumer caller | Module lifecycle | Field `consumerDeliveryAttempts` on this DTO (see source semantics). |
| `consumerDeliveryLastError` | `string \| null` | no | Consumer caller | Module lifecycle | Field `consumerDeliveryLastError` on this DTO (see source semantics). |
| `createdAt` | `string` | yes | Consumer caller | Module lifecycle | Field `createdAt` on this DTO (see source semantics). |
| `updatedAt` | `string` | yes | Consumer caller | Module lifecycle | Field `updatedAt` on this DTO (see source semantics). |

#### `ProviderEvidenceRecord`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `rawPayload` | `string` | yes | Consumer caller | Module lifecycle | Field `rawPayload` on this DTO (see source semantics). |

#### `InsertProviderEvidenceInput`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module persistence + reconciliation | Field `providerCode` on this DTO (see source semantics). |
| `accountRef` | `string` | yes | Consumer caller | Module lifecycle | Field `accountRef` on this DTO (see source semantics). |
| `applicationRef` | `string` | yes | Consumer caller | Module lifecycle | Field `applicationRef` on this DTO (see source semantics). |
| `environment` | `PaymentEnvironment` | yes | Consumer caller | Module lifecycle | Field `environment` on this DTO (see source semantics). |
| `evidenceKind` | `ProviderEvidenceKind` | yes | Consumer caller | Module lifecycle | Field `evidenceKind` on this DTO (see source semantics). |
| `providerEventId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerEventId` on this DTO (see source semantics). |
| `rawPayload` | `string` | yes | Consumer caller | Module lifecycle | Field `rawPayload` on this DTO (see source semantics). |
| `payloadSha256` | `string` | yes | Consumer caller | Module lifecycle | Hash of rawPayload for integrity checks. |
| `eventType` | `string \| null` | no | Consumer caller | Module lifecycle | Field `eventType` on this DTO (see source semantics). |
| `resourceId` | `string \| null` | no | Consumer caller | Module lifecycle | Field `resourceId` on this DTO (see source semantics). |

#### `UpdateProviderEvidenceInput`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `evidenceId` | `string` | yes | Consumer caller | Module lifecycle | Field `evidenceId` on this DTO (see source semantics). |
| `verificationStatus` | `EvidenceVerificationStatus` | no | Consumer caller | Module lifecycle | Field `verificationStatus` on this DTO (see source semantics). |
| `processingStatus` | `EvidenceProcessingStatus` | no | Consumer caller | Module lifecycle | Field `processingStatus` on this DTO (see source semantics). |
| `relatedOperationId` | `string \| null` | no | Module lifecycle | Module lifecycle | Field `relatedOperationId` on this DTO (see source semantics). |
| `eventType` | `string \| null` | no | Consumer caller | Module lifecycle | Field `eventType` on this DTO (see source semantics). |
| `resourceId` | `string \| null` | no | Consumer caller | Module lifecycle | Field `resourceId` on this DTO (see source semantics). |
| `errorCode` | `string \| null` | no | Consumer caller | Module lifecycle | Field `errorCode` on this DTO (see source semantics). |
| `errorMessage` | `string \| null` | no | Consumer caller | Module lifecycle | Field `errorMessage` on this DTO (see source semantics). |
| `claimLeaseExpiresAt` | `string \| null` | no | Consumer caller | Module lifecycle | Field `claimLeaseExpiresAt` on this DTO (see source semantics). |
| `claimWorkerId` | `string \| null` | no | Consumer caller | Module lifecycle | Field `claimWorkerId` on this DTO (see source semantics). |
| `processedAt` | `string \| null` | no | Consumer caller | Module lifecycle | Field `processedAt` on this DTO (see source semantics). |
| `consumerDeliveryStatus` | `ConsumerDeliveryStatus` | no | Consumer caller | Module lifecycle | Field `consumerDeliveryStatus` on this DTO (see source semantics). |
| `consumerDeliveredAt` | `string \| null` | no | Consumer caller | Module lifecycle | Field `consumerDeliveredAt` on this DTO (see source semantics). |
| `consumerDeliveryAttempts` | `number` | no | Consumer caller | Module lifecycle | Field `consumerDeliveryAttempts` on this DTO (see source semantics). |
| `consumerDeliveryLastError` | `string \| null` | no | Consumer caller | Module lifecycle | Field `consumerDeliveryLastError` on this DTO (see source semantics). |

#### `ReconciliationAttempt`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `attemptId` | `string` | yes | Module / store | Admin queries | Reconciliation attempt row id. |
| `evidenceId` | `string` | yes | Module | Store | Related evidence id. |
| `operationId` | `string \| null` | yes | Module | Store | Related operation when correlated. |
| `outcome` | `'applied' \| 'retryable_failure' \| 'terminal_failure' \| 'no_op'` | yes | Module | Store / metrics | Reconciliation outcome bucket. |
| `resultCode` | `string \| null` | yes | Module | Store / metrics | Structured result code when set. |
| `resultMessage` | `string \| null` | yes | Module | Store / metrics | Sanitized operator message when set. |
| `createdAt` | `string` | yes | Store | Admin queries | Insert timestamp. |

### `execution-mode.ts`

#### `NormalizedDeployedPaymentConfig`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `nodeEnv` | `string` | yes | Consumer caller | Module lifecycle | Field `nodeEnv` on this DTO (see source semantics). |
| `providerEnvironment` | `PaymentEnvironment \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerEnvironment` on this DTO (see source semantics). |
| `providerEnvironmentInvalid` | `boolean` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerEnvironmentInvalid` on this DTO (see source semantics). |
| `financialSimulation` | `boolean` | no | Consumer caller | Module lifecycle | Field `financialSimulation` on this DTO (see source semantics). |
| `legacyPaymentExecutionMode` | `string \| null` | no | Consumer caller | Module lifecycle | Field `legacyPaymentExecutionMode` on this DTO (see source semantics). |
| `legacyPaymentDeploymentEnvironment` | `string \| null` | no | Consumer caller | Module lifecycle | Field `legacyPaymentDeploymentEnvironment` on this DTO (see source semantics). |
| `legacyFundingSimulation` | `string \| null` | no | Consumer caller | Module lifecycle | Field `legacyFundingSimulation` on this DTO (see source semantics). |

### `marketplace.ts`

#### `MarketplaceUnitInput`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `sellerRef` | `string` | yes | Consumer caller | Module lifecycle | Field `sellerRef` on this DTO (see source semantics). |
| `referenceId` | `string` | yes | Consumer caller | Module lifecycle | Field `referenceId` on this DTO (see source semantics). |
| `amount` | `CanonicalMoney` | yes | Consumer caller | Module lifecycle | Field `amount` on this DTO (see source semantics). |
| `platformFee` | `CanonicalMoney \| null` | no | Consumer caller | Module lifecycle | Field `platformFee` on this DTO (see source semantics). |

#### `CreateMarketplaceOrderRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `idempotencyKey` | `string` | yes | Consumer caller | Module store | Command deduplication key within idempotency scope. |
| `correlationId` | `string \| null` | no | Consumer caller | Module store | Optional consumer tracing reference stored on the operation. |
| `returnUrl` | `string \| null` | no | Consumer caller | Module lifecycle | Field `returnUrl` on this DTO (see source semantics). |
| `cancelUrl` | `string \| null` | no | Consumer caller | Module lifecycle | Field `cancelUrl` on this DTO (see source semantics). |
| `units` | `MarketplaceUnitInput[]` | yes | Consumer caller | Module lifecycle | Field `units` on this DTO (see source semantics). |

#### `GetMarketplaceOrderRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `marketplaceOperationId` | `string` | yes | Module lifecycle | Module lifecycle | Field `marketplaceOperationId` on this DTO (see source semantics). |

#### `CaptureMarketplaceOrderRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `idempotencyKey` | `string` | yes | Consumer caller | Module store | Command deduplication key within idempotency scope. |
| `correlationId` | `string \| null` | no | Consumer caller | Module store | Optional consumer tracing reference stored on the operation. |
| `marketplaceOperationId` | `string` | yes | Module lifecycle | Module lifecycle | Field `marketplaceOperationId` on this DTO (see source semantics). |
| `providerOrderId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerOrderId` on this DTO (see source semantics). |

#### `RefundMarketplaceUnitRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `idempotencyKey` | `string` | yes | Consumer caller | Module store | Command deduplication key within idempotency scope. |
| `correlationId` | `string \| null` | no | Consumer caller | Module store | Optional consumer tracing reference stored on the operation. |
| `marketplaceOperationId` | `string` | yes | Module lifecycle | Module lifecycle | Field `marketplaceOperationId` on this DTO (see source semantics). |
| `referenceId` | `string` | yes | Consumer caller | Module lifecycle | Field `referenceId` on this DTO (see source semantics). |
| `providerCaptureId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerCaptureId` on this DTO (see source semantics). |
| `amount` | `CanonicalMoney \| null` | no | Consumer caller | Module lifecycle | Field `amount` on this DTO (see source semantics). |
| `platformFeeRefund` | `CanonicalMoney \| null` | no | Consumer caller | Module lifecycle | Field `platformFeeRefund` on this DTO (see source semantics). |

#### `MarketplaceUnitResult`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `referenceId` | `string` | yes | Consumer caller | Module lifecycle | Field `referenceId` on this DTO (see source semantics). |
| `sellerRef` | `string` | yes | Consumer caller | Module lifecycle | Field `sellerRef` on this DTO (see source semantics). |
| `providerMerchantId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerMerchantId` on this DTO (see source semantics). |
| `unitStatus` | `MarketplaceUnitStatus` | yes | Consumer caller | Module lifecycle | Field `unitStatus` on this DTO (see source semantics). |
| `amount` | `CanonicalMoney` | yes | Consumer caller | Module lifecycle | Field `amount` on this DTO (see source semantics). |
| `platformFee` | `CanonicalMoney \| null` | yes | Consumer caller | Module lifecycle | Field `platformFee` on this DTO (see source semantics). |
| `providerCaptureId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerCaptureId` on this DTO (see source semantics). |
| `providerFee` | `CanonicalMoney \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerFee` on this DTO (see source semantics). |
| `netAmount` | `CanonicalMoney \| null` | yes | Consumer caller | Module lifecycle | Field `netAmount` on this DTO (see source semantics). |
| `refundedAmount` | `CanonicalMoney \| null` | yes | Consumer caller | Module lifecycle | Field `refundedAmount` on this DTO (see source semantics). |

#### `MarketplaceOrderResult`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `operationId` | `string` | yes | Module lifecycle | Module lifecycle | Field `operationId` on this DTO (see source semantics). |
| `operationStatus` | `PaymentOperationStatus` | yes | Consumer caller | Module lifecycle | Field `operationStatus` on this DTO (see source semantics). |
| `providerOrderId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerOrderId` on this DTO (see source semantics). |
| `marketplaceStatus` | `MarketplaceOrderStatus` | yes | Consumer caller | Module lifecycle | Field `marketplaceStatus` on this DTO (see source semantics). |
| `approvalUrl` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `approvalUrl` on this DTO (see source semantics). |
| `units` | `MarketplaceUnitResult[]` | yes | Consumer caller | Module lifecycle | Field `units` on this DTO (see source semantics). |
| `correlationId` | `string \| null` | yes | Consumer caller | Module store | Optional consumer tracing reference stored on the operation. |
| `providerDebugId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerDebugId` on this DTO (see source semantics). |

#### `RefundMarketplaceUnitResult`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `operationId` | `string` | yes | Module lifecycle | Module lifecycle | Field `operationId` on this DTO (see source semantics). |
| `operationStatus` | `PaymentOperationStatus` | yes | Consumer caller | Module lifecycle | Field `operationStatus` on this DTO (see source semantics). |
| `marketplaceOperationId` | `string` | yes | Module lifecycle | Module lifecycle | Field `marketplaceOperationId` on this DTO (see source semantics). |
| `referenceId` | `string` | yes | Consumer caller | Module lifecycle | Field `referenceId` on this DTO (see source semantics). |
| `providerCaptureId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerCaptureId` on this DTO (see source semantics). |
| `providerRefundId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerRefundId` on this DTO (see source semantics). |
| `refundStatus` | `'pending' \| 'completed' \| 'failed' \| 'unknown'` | yes | Consumer caller | Module lifecycle | Field `refundStatus` on this DTO (see source semantics). |
| `amount` | `CanonicalMoney \| null` | yes | Consumer caller | Module lifecycle | Field `amount` on this DTO (see source semantics). |
| `correlationId` | `string \| null` | yes | Consumer caller | Module store | Optional consumer tracing reference stored on the operation. |
| `providerDebugId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerDebugId` on this DTO (see source semantics). |

#### `MarketplacePurchaseUnitRecord`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `unitId` | `string` | yes | Consumer caller | Module lifecycle | Field `unitId` on this DTO (see source semantics). |
| `operationId` | `string` | yes | Module lifecycle | Module lifecycle | Field `operationId` on this DTO (see source semantics). |
| `referenceId` | `string` | yes | Consumer caller | Module lifecycle | Field `referenceId` on this DTO (see source semantics). |
| `sellerRef` | `string` | yes | Consumer caller | Module lifecycle | Field `sellerRef` on this DTO (see source semantics). |
| `providerMerchantId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerMerchantId` on this DTO (see source semantics). |
| `amountMinor` | `string` | yes | Consumer caller | Module lifecycle | Integer minor units as decimal string (see CanonicalMoney). |
| `currencyCode` | `string` | yes | Consumer caller | Module lifecycle | ISO currency code paired with amountMinor on store rows. |
| `platformFeeMinor` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `platformFeeMinor` on this DTO (see source semantics). |
| `platformFeeCurrency` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `platformFeeCurrency` on this DTO (see source semantics). |
| `unitStatus` | `MarketplaceUnitStatus` | yes | Consumer caller | Module lifecycle | Field `unitStatus` on this DTO (see source semantics). |
| `providerCaptureId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerCaptureId` on this DTO (see source semantics). |
| `providerFeeMinor` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerFeeMinor` on this DTO (see source semantics). |
| `providerFeeCurrency` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerFeeCurrency` on this DTO (see source semantics). |
| `netAmountMinor` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `netAmountMinor` on this DTO (see source semantics). |
| `refundedMinor` | `string` | yes | Consumer caller | Module lifecycle | Field `refundedMinor` on this DTO (see source semantics). |
| `version` | `number` | yes | Consumer caller | Module lifecycle | Field `version` on this DTO (see source semantics). |
| `createdAt` | `string` | yes | Consumer caller | Module lifecycle | Field `createdAt` on this DTO (see source semantics). |
| `updatedAt` | `string` | yes | Consumer caller | Module lifecycle | Field `updatedAt` on this DTO (see source semantics). |

#### `InsertMarketplacePurchaseUnitInput`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `operationId` | `string` | yes | Module lifecycle | Module lifecycle | Field `operationId` on this DTO (see source semantics). |
| `referenceId` | `string` | yes | Consumer caller | Module lifecycle | Field `referenceId` on this DTO (see source semantics). |
| `sellerRef` | `string` | yes | Consumer caller | Module lifecycle | Field `sellerRef` on this DTO (see source semantics). |
| `providerMerchantId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerMerchantId` on this DTO (see source semantics). |
| `amountMinor` | `string` | yes | Consumer caller | Module lifecycle | Integer minor units as decimal string (see CanonicalMoney). |
| `currencyCode` | `string` | yes | Consumer caller | Module lifecycle | ISO currency code paired with amountMinor on store rows. |
| `platformFeeMinor` | `string \| null` | no | Consumer caller | Module lifecycle | Field `platformFeeMinor` on this DTO (see source semantics). |
| `platformFeeCurrency` | `string \| null` | no | Consumer caller | Module lifecycle | Field `platformFeeCurrency` on this DTO (see source semantics). |
| `unitStatus` | `MarketplaceUnitStatus` | no | Consumer caller | Module lifecycle | Field `unitStatus` on this DTO (see source semantics). |

#### `UpdateMarketplacePurchaseUnitInput`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `unitId` | `string` | yes | Consumer caller | Module lifecycle | Field `unitId` on this DTO (see source semantics). |
| `expectedVersion` | `number` | yes | Consumer caller | Module lifecycle | Field `expectedVersion` on this DTO (see source semantics). |
| `unitStatus` | `MarketplaceUnitStatus` | no | Consumer caller | Module lifecycle | Field `unitStatus` on this DTO (see source semantics). |
| `providerCaptureId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerCaptureId` on this DTO (see source semantics). |
| `providerFeeMinor` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerFeeMinor` on this DTO (see source semantics). |
| `providerFeeCurrency` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerFeeCurrency` on this DTO (see source semantics). |
| `netAmountMinor` | `string \| null` | no | Consumer caller | Module lifecycle | Field `netAmountMinor` on this DTO (see source semantics). |
| `refundedMinor` | `string` | no | Consumer caller | Module lifecycle | Field `refundedMinor` on this DTO (see source semantics). |

#### `ExecuteMarketplaceUnit`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `referenceId` | `string` | yes | Consumer caller | Module lifecycle | Field `referenceId` on this DTO (see source semantics). |
| `providerMerchantId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerMerchantId` on this DTO (see source semantics). |
| `amount` | `CanonicalMoney` | yes | Consumer caller | Module lifecycle | Field `amount` on this DTO (see source semantics). |
| `platformFee` | `CanonicalMoney \| null` | no | Consumer caller | Module lifecycle | Field `platformFee` on this DTO (see source semantics). |

#### `ExecuteCreateMarketplaceOrderRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `providerRequestId` | `string` | yes | Provider adapter / module | Provider port implementation | Module-generated idempotency token for a single provider HTTP attempt. |
| `returnUrl` | `string \| null` | no | Consumer caller | Module lifecycle | Field `returnUrl` on this DTO (see source semantics). |
| `cancelUrl` | `string \| null` | no | Consumer caller | Module lifecycle | Field `cancelUrl` on this DTO (see source semantics). |
| `units` | `ExecuteMarketplaceUnit[]` | yes | Consumer caller | Module lifecycle | Field `units` on this DTO (see source semantics). |

#### `ExecuteMarketplaceUnitSnapshot`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `referenceId` | `string` | yes | Consumer caller | Module lifecycle | Field `referenceId` on this DTO (see source semantics). |
| `providerMerchantId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerMerchantId` on this DTO (see source semantics). |
| `amount` | `CanonicalMoney` | yes | Consumer caller | Module lifecycle | Field `amount` on this DTO (see source semantics). |
| `platformFee` | `CanonicalMoney \| null` | yes | Consumer caller | Module lifecycle | Field `platformFee` on this DTO (see source semantics). |
| `unitStatus` | `MarketplaceUnitStatus` | yes | Consumer caller | Module lifecycle | Field `unitStatus` on this DTO (see source semantics). |
| `providerCaptureId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerCaptureId` on this DTO (see source semantics). |
| `providerFee` | `CanonicalMoney \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerFee` on this DTO (see source semantics). |
| `netAmount` | `CanonicalMoney \| null` | yes | Consumer caller | Module lifecycle | Field `netAmount` on this DTO (see source semantics). |

#### `ExecuteCreateMarketplaceOrderResult`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerOrderId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerOrderId` on this DTO (see source semantics). |
| `marketplaceStatus` | `MarketplaceOrderStatus` | yes | Consumer caller | Module lifecycle | Field `marketplaceStatus` on this DTO (see source semantics). |
| `approvalUrl` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `approvalUrl` on this DTO (see source semantics). |
| `units` | `ExecuteMarketplaceUnitSnapshot[]` | yes | Consumer caller | Module lifecycle | Field `units` on this DTO (see source semantics). |
| `providerDebugId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerDebugId` on this DTO (see source semantics). |

#### `ExecuteGetMarketplaceOrderRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `providerOrderId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerOrderId` on this DTO (see source semantics). |

#### `ExecuteGetMarketplaceOrderResult`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerOrderId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerOrderId` on this DTO (see source semantics). |
| `marketplaceStatus` | `MarketplaceOrderStatus` | yes | Consumer caller | Module lifecycle | Field `marketplaceStatus` on this DTO (see source semantics). |
| `approvalUrl` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `approvalUrl` on this DTO (see source semantics). |
| `units` | `ExecuteMarketplaceUnitSnapshot[]` | yes | Consumer caller | Module lifecycle | Field `units` on this DTO (see source semantics). |
| `providerDebugId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerDebugId` on this DTO (see source semantics). |

#### `ExecuteCaptureMarketplaceOrderRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `providerRequestId` | `string` | yes | Provider adapter / module | Provider port implementation | Module-generated idempotency token for a single provider HTTP attempt. |
| `providerOrderId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerOrderId` on this DTO (see source semantics). |

#### `ExecuteCaptureMarketplaceOrderResult`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerOrderId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerOrderId` on this DTO (see source semantics). |
| `marketplaceStatus` | `MarketplaceOrderStatus` | yes | Consumer caller | Module lifecycle | Field `marketplaceStatus` on this DTO (see source semantics). |
| `units` | `ExecuteMarketplaceUnitSnapshot[]` | yes | Consumer caller | Module lifecycle | Field `units` on this DTO (see source semantics). |
| `httpStatus` | `number` | yes | Consumer caller | Module lifecycle | Field `httpStatus` on this DTO (see source semantics). |
| `providerDebugId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerDebugId` on this DTO (see source semantics). |

#### `ExecuteRefundMarketplaceUnitRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module persistence + reconciliation | Field `providerCode` on this DTO (see source semantics). |
| `accountRef` | `string` | yes | Consumer caller | Module lifecycle | Field `accountRef` on this DTO (see source semantics). |
| `applicationRef` | `string` | yes | Consumer caller | Module lifecycle | Field `applicationRef` on this DTO (see source semantics). |
| `environment` | `CheckoutProviderContext['environment']` | yes | Consumer caller | Module lifecycle | Field `environment` on this DTO (see source semantics). |
| `providerRequestId` | `string` | yes | Provider adapter / module | Provider port implementation | Module-generated idempotency token for a single provider HTTP attempt. |
| `providerCaptureId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerCaptureId` on this DTO (see source semantics). |
| `amount` | `CanonicalMoney \| null` | no | Consumer caller | Module lifecycle | Field `amount` on this DTO (see source semantics). |
| `platformFeeRefund` | `CanonicalMoney \| null` | no | Consumer caller | Module lifecycle | Field `platformFeeRefund` on this DTO (see source semantics). |

### `money.ts`

#### `CanonicalMoney`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `currency` | `string` | yes | Consumer caller | Module lifecycle | Field `currency` on this DTO (see source semantics). |
| `amountMinor` | `string` | yes | Consumer caller | Module lifecycle | Integer minor units as decimal string (see CanonicalMoney). |

### `operation-result.ts`

#### `NormalizedPaymentFailure`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `code` | `string` | yes | Consumer caller | Module lifecycle | Field `code` on this DTO (see source semantics). |
| `category` | `PaymentFailureCategory` | yes | Consumer caller | Module lifecycle | Field `category` on this DTO (see source semantics). |
| `causeCode` | `PaymentCauseCode \| string` | yes | Consumer caller | Module lifecycle | Field `causeCode` on this DTO (see source semantics). |
| `nextAction` | `PaymentNextAction` | yes | Module lifecycle | Module lifecycle | Field `nextAction` on this DTO (see source semantics). |

#### `ClassifiedPaymentFailure`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `uncertain` | `boolean` | yes | Consumer caller | Module lifecycle | Field `uncertain` on this DTO (see source semantics). |
| `retryable` | `boolean` | yes | Consumer caller | Module lifecycle | Field `retryable` on this DTO (see source semantics). |
| `diagnosticMessage` | `string` | yes | Consumer caller | Module lifecycle | Field `diagnosticMessage` on this DTO (see source semantics). |

### `operations.ts`

#### `PaymentOperation`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `operationId` | `string` | yes | Module lifecycle | Module lifecycle | Field `operationId` on this DTO (see source semantics). |
| `idempotencyKey` | `string` | yes | Consumer caller | Module store | Command deduplication key within idempotency scope. |
| `idempotencyScope` | `string` | yes | Consumer caller | Module lifecycle | Field `idempotencyScope` on this DTO (see source semantics). |
| `commandFingerprint` | `string` | yes | Consumer caller | Module lifecycle | Field `commandFingerprint` on this DTO (see source semantics). |
| `providerCode` | `string` | yes | Consumer caller | Module persistence + reconciliation | Field `providerCode` on this DTO (see source semantics). |
| `accountRef` | `string` | yes | Consumer caller | Module lifecycle | Field `accountRef` on this DTO (see source semantics). |
| `applicationRef` | `string` | yes | Consumer caller | Module lifecycle | Field `applicationRef` on this DTO (see source semantics). |
| `environment` | `PaymentEnvironment` | yes | Consumer caller | Module lifecycle | Field `environment` on this DTO (see source semantics). |
| `providerReferenceId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerReferenceId` on this DTO (see source semantics). |
| `kind` | `PaymentOperationKind` | yes | Consumer caller | Module lifecycle | Field `kind` on this DTO (see source semantics). |
| `status` | `PaymentOperationStatus` | yes | Consumer caller | Module lifecycle | Field `status` on this DTO (see source semantics). |
| `correlationId` | `string \| null` | yes | Consumer caller | Module store | Optional consumer tracing reference stored on the operation. |
| `failureCode` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `failureCode` on this DTO (see source semantics). |
| `failureMessage` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `failureMessage` on this DTO (see source semantics). |
| `parentOperationId` | `string \| null` | yes | Module lifecycle | Module lifecycle | Field `parentOperationId` on this DTO (see source semantics). |
| `approvalUrl` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `approvalUrl` on this DTO (see source semantics). |
| `amountMinor` | `string \| null` | yes | Consumer caller | Module lifecycle | Integer minor units as decimal string (see CanonicalMoney). |
| `currencyCode` | `string \| null` | yes | Consumer caller | Module lifecycle | ISO currency code paired with amountMinor on store rows. |
| `providerOrderId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerOrderId` on this DTO (see source semantics). |
| `providerCaptureId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerCaptureId` on this DTO (see source semantics). |
| `providerRefundId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerRefundId` on this DTO (see source semantics). |
| `senderBatchId` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `senderBatchId` on this DTO (see source semantics). |
| `senderItemId` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `senderItemId` on this DTO (see source semantics). |
| `providerPayoutBatchId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerPayoutBatchId` on this DTO (see source semantics). |
| `providerPayoutItemId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerPayoutItemId` on this DTO (see source semantics). |
| `payoutStatus` | `PayoutFinancialStatus \| null` | yes | Consumer caller | Module lifecycle | Field `payoutStatus` on this DTO (see source semantics). |
| `recipientType` | `PayoutRecipientType \| null` | yes | Consumer caller | Module lifecycle | Field `recipientType` on this DTO (see source semantics). |
| `maskedDestination` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `maskedDestination` on this DTO (see source semantics). |
| `recipientValue` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `recipientValue` on this DTO (see source semantics). |
| `providerTransactionId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerTransactionId` on this DTO (see source semantics). |
| `providerFeeMinor` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerFeeMinor` on this DTO (see source semantics). |
| `providerFeeCurrency` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerFeeCurrency` on this DTO (see source semantics). |
| `itemRef` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `itemRef` on this DTO (see source semantics). |
| `productStatus` | `ProductStatus \| null` | yes | Consumer caller | Module lifecycle | Field `productStatus` on this DTO (see source semantics). |
| `planStatus` | `PlanStatus \| null` | yes | Consumer caller | Module lifecycle | Field `planStatus` on this DTO (see source semantics). |
| `subscriptionStatus` | `SubscriptionStatus \| null` | yes | Consumer caller | Module lifecycle | Field `subscriptionStatus` on this DTO (see source semantics). |
| `providerProductId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerProductId` on this DTO (see source semantics). |
| `providerPlanId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerPlanId` on this DTO (see source semantics). |
| `providerSubscriptionId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerSubscriptionId` on this DTO (see source semantics). |
| `offeringRef` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `offeringRef` on this DTO (see source semantics). |
| `maskedSubscriber` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `maskedSubscriber` on this DTO (see source semantics). |
| `subscriberRef` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `subscriberRef` on this DTO (see source semantics). |
| `subscriberEmail` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `subscriberEmail` on this DTO (see source semantics). |
| `startTime` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `startTime` on this DTO (see source semantics). |
| `nextBillingTime` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `nextBillingTime` on this DTO (see source semantics). |
| `lifecycleReason` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `lifecycleReason` on this DTO (see source semantics). |
| `providerSubscriptionStateAt` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerSubscriptionStateAt` on this DTO (see source semantics). |
| `sellerRef` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `sellerRef` on this DTO (see source semantics). |
| `providerReferralId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerReferralId` on this DTO (see source semantics). |
| `executionLeaseExpiresAt` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `executionLeaseExpiresAt` on this DTO (see source semantics). |
| `executionOwnerToken` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `executionOwnerToken` on this DTO (see source semantics). |
| `version` | `number` | yes | Consumer caller | Module lifecycle | Field `version` on this DTO (see source semantics). |
| `createdAt` | `string` | yes | Consumer caller | Module lifecycle | Field `createdAt` on this DTO (see source semantics). |
| `updatedAt` | `string` | yes | Consumer caller | Module lifecycle | Field `updatedAt` on this DTO (see source semantics). |

#### `CreatePaymentOperationInput`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `idempotencyKey` | `string` | yes | Consumer caller | Module store | Command deduplication key within idempotency scope. |
| `idempotencyScope` | `string` | yes | Consumer caller | Module lifecycle | Field `idempotencyScope` on this DTO (see source semantics). |
| `commandFingerprint` | `string` | yes | Consumer caller | Module lifecycle | Field `commandFingerprint` on this DTO (see source semantics). |
| `providerCode` | `string` | yes | Consumer caller | Module persistence + reconciliation | Field `providerCode` on this DTO (see source semantics). |
| `accountRef` | `string` | yes | Consumer caller | Module lifecycle | Field `accountRef` on this DTO (see source semantics). |
| `applicationRef` | `string` | yes | Consumer caller | Module lifecycle | Field `applicationRef` on this DTO (see source semantics). |
| `environment` | `PaymentEnvironment` | yes | Consumer caller | Module lifecycle | Field `environment` on this DTO (see source semantics). |
| `kind` | `PaymentOperationKind` | yes | Consumer caller | Module lifecycle | Field `kind` on this DTO (see source semantics). |
| `correlationId` | `string \| null` | no | Consumer caller | Module store | Optional consumer tracing reference stored on the operation. |
| `providerReferenceId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerReferenceId` on this DTO (see source semantics). |
| `parentOperationId` | `string \| null` | no | Module lifecycle | Module lifecycle | Field `parentOperationId` on this DTO (see source semantics). |
| `amountMinor` | `string \| null` | no | Consumer caller | Module lifecycle | Integer minor units as decimal string (see CanonicalMoney). |
| `currencyCode` | `string \| null` | no | Consumer caller | Module lifecycle | ISO currency code paired with amountMinor on store rows. |
| `providerOrderId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerOrderId` on this DTO (see source semantics). |
| `providerCaptureId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerCaptureId` on this DTO (see source semantics). |
| `senderBatchId` | `string \| null` | no | Consumer caller | Module lifecycle | Field `senderBatchId` on this DTO (see source semantics). |
| `senderItemId` | `string \| null` | no | Consumer caller | Module lifecycle | Field `senderItemId` on this DTO (see source semantics). |
| `providerPayoutBatchId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerPayoutBatchId` on this DTO (see source semantics). |
| `providerPayoutItemId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerPayoutItemId` on this DTO (see source semantics). |
| `payoutStatus` | `PayoutFinancialStatus \| null` | no | Consumer caller | Module lifecycle | Field `payoutStatus` on this DTO (see source semantics). |
| `recipientType` | `PayoutRecipientType \| null` | no | Consumer caller | Module lifecycle | Field `recipientType` on this DTO (see source semantics). |
| `maskedDestination` | `string \| null` | no | Consumer caller | Module lifecycle | Field `maskedDestination` on this DTO (see source semantics). |
| `recipientValue` | `string \| null` | no | Consumer caller | Module lifecycle | Field `recipientValue` on this DTO (see source semantics). |
| `providerTransactionId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerTransactionId` on this DTO (see source semantics). |
| `providerFeeMinor` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerFeeMinor` on this DTO (see source semantics). |
| `providerFeeCurrency` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerFeeCurrency` on this DTO (see source semantics). |
| `itemRef` | `string \| null` | no | Consumer caller | Module lifecycle | Field `itemRef` on this DTO (see source semantics). |
| `productStatus` | `ProductStatus \| null` | no | Consumer caller | Module lifecycle | Field `productStatus` on this DTO (see source semantics). |
| `planStatus` | `PlanStatus \| null` | no | Consumer caller | Module lifecycle | Field `planStatus` on this DTO (see source semantics). |
| `subscriptionStatus` | `SubscriptionStatus \| null` | no | Consumer caller | Module lifecycle | Field `subscriptionStatus` on this DTO (see source semantics). |
| `providerProductId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerProductId` on this DTO (see source semantics). |
| `providerPlanId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerPlanId` on this DTO (see source semantics). |
| `providerSubscriptionId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerSubscriptionId` on this DTO (see source semantics). |
| `offeringRef` | `string \| null` | no | Consumer caller | Module lifecycle | Field `offeringRef` on this DTO (see source semantics). |
| `maskedSubscriber` | `string \| null` | no | Consumer caller | Module lifecycle | Field `maskedSubscriber` on this DTO (see source semantics). |
| `subscriberRef` | `string \| null` | no | Consumer caller | Module lifecycle | Field `subscriberRef` on this DTO (see source semantics). |
| `subscriberEmail` | `string \| null` | no | Consumer caller | Module lifecycle | Field `subscriberEmail` on this DTO (see source semantics). |
| `startTime` | `string \| null` | no | Consumer caller | Module lifecycle | Field `startTime` on this DTO (see source semantics). |
| `nextBillingTime` | `string \| null` | no | Consumer caller | Module lifecycle | Field `nextBillingTime` on this DTO (see source semantics). |
| `lifecycleReason` | `string \| null` | no | Consumer caller | Module lifecycle | Field `lifecycleReason` on this DTO (see source semantics). |
| `providerSubscriptionStateAt` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerSubscriptionStateAt` on this DTO (see source semantics). |
| `sellerRef` | `string \| null` | no | Consumer caller | Module lifecycle | Field `sellerRef` on this DTO (see source semantics). |
| `providerReferralId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerReferralId` on this DTO (see source semantics). |
| `executionLeaseExpiresAt` | `string \| null` | no | Consumer caller | Module lifecycle | Field `executionLeaseExpiresAt` on this DTO (see source semantics). |
| `executionOwnerToken` | `string \| null` | no | Consumer caller | Module lifecycle | Field `executionOwnerToken` on this DTO (see source semantics). |

#### `TransitionPaymentOperationInput`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `operationId` | `string` | yes | Module lifecycle | Module lifecycle | Field `operationId` on this DTO (see source semantics). |
| `expectedVersion` | `number` | yes | Consumer caller | Module lifecycle | Field `expectedVersion` on this DTO (see source semantics). |
| `nextStatus` | `PaymentOperationStatus` | yes | Consumer caller | Module lifecycle | Field `nextStatus` on this DTO (see source semantics). |
| `providerReferenceId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerReferenceId` on this DTO (see source semantics). |
| `failureCode` | `string \| null` | no | Consumer caller | Module lifecycle | Field `failureCode` on this DTO (see source semantics). |
| `failureMessage` | `string \| null` | no | Consumer caller | Module lifecycle | Field `failureMessage` on this DTO (see source semantics). |
| `evidenceId` | `string \| null` | no | Consumer caller | Module lifecycle | Field `evidenceId` on this DTO (see source semantics). |
| `approvalUrl` | `string \| null` | no | Consumer caller | Module lifecycle | Field `approvalUrl` on this DTO (see source semantics). |
| `amountMinor` | `string \| null` | no | Consumer caller | Module lifecycle | Integer minor units as decimal string (see CanonicalMoney). |
| `currencyCode` | `string \| null` | no | Consumer caller | Module lifecycle | ISO currency code paired with amountMinor on store rows. |
| `providerOrderId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerOrderId` on this DTO (see source semantics). |
| `providerCaptureId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerCaptureId` on this DTO (see source semantics). |
| `providerRefundId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerRefundId` on this DTO (see source semantics). |
| `senderBatchId` | `string \| null` | no | Consumer caller | Module lifecycle | Field `senderBatchId` on this DTO (see source semantics). |
| `senderItemId` | `string \| null` | no | Consumer caller | Module lifecycle | Field `senderItemId` on this DTO (see source semantics). |
| `providerPayoutBatchId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerPayoutBatchId` on this DTO (see source semantics). |
| `providerPayoutItemId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerPayoutItemId` on this DTO (see source semantics). |
| `payoutStatus` | `PayoutFinancialStatus \| null` | no | Consumer caller | Module lifecycle | Field `payoutStatus` on this DTO (see source semantics). |
| `recipientType` | `PayoutRecipientType \| null` | no | Consumer caller | Module lifecycle | Field `recipientType` on this DTO (see source semantics). |
| `maskedDestination` | `string \| null` | no | Consumer caller | Module lifecycle | Field `maskedDestination` on this DTO (see source semantics). |
| `recipientValue` | `string \| null` | no | Consumer caller | Module lifecycle | Field `recipientValue` on this DTO (see source semantics). |
| `providerTransactionId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerTransactionId` on this DTO (see source semantics). |
| `providerFeeMinor` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerFeeMinor` on this DTO (see source semantics). |
| `providerFeeCurrency` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerFeeCurrency` on this DTO (see source semantics). |
| `itemRef` | `string \| null` | no | Consumer caller | Module lifecycle | Field `itemRef` on this DTO (see source semantics). |
| `productStatus` | `ProductStatus \| null` | no | Consumer caller | Module lifecycle | Field `productStatus` on this DTO (see source semantics). |
| `planStatus` | `PlanStatus \| null` | no | Consumer caller | Module lifecycle | Field `planStatus` on this DTO (see source semantics). |
| `subscriptionStatus` | `SubscriptionStatus \| null` | no | Consumer caller | Module lifecycle | Field `subscriptionStatus` on this DTO (see source semantics). |
| `providerProductId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerProductId` on this DTO (see source semantics). |
| `providerPlanId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerPlanId` on this DTO (see source semantics). |
| `providerSubscriptionId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerSubscriptionId` on this DTO (see source semantics). |
| `offeringRef` | `string \| null` | no | Consumer caller | Module lifecycle | Field `offeringRef` on this DTO (see source semantics). |
| `maskedSubscriber` | `string \| null` | no | Consumer caller | Module lifecycle | Field `maskedSubscriber` on this DTO (see source semantics). |
| `subscriberRef` | `string \| null` | no | Consumer caller | Module lifecycle | Field `subscriberRef` on this DTO (see source semantics). |
| `subscriberEmail` | `string \| null` | no | Consumer caller | Module lifecycle | Field `subscriberEmail` on this DTO (see source semantics). |
| `startTime` | `string \| null` | no | Consumer caller | Module lifecycle | Field `startTime` on this DTO (see source semantics). |
| `nextBillingTime` | `string \| null` | no | Consumer caller | Module lifecycle | Field `nextBillingTime` on this DTO (see source semantics). |
| `lifecycleReason` | `string \| null` | no | Consumer caller | Module lifecycle | Field `lifecycleReason` on this DTO (see source semantics). |
| `providerSubscriptionStateAt` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerSubscriptionStateAt` on this DTO (see source semantics). |
| `sellerRef` | `string \| null` | no | Consumer caller | Module lifecycle | Field `sellerRef` on this DTO (see source semantics). |
| `providerReferralId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerReferralId` on this DTO (see source semantics). |
| `executionLeaseExpiresAt` | `string \| null` | no | Consumer caller | Module lifecycle | Field `executionLeaseExpiresAt` on this DTO (see source semantics). |
| `executionOwnerToken` | `string \| null` | no | Consumer caller | Module lifecycle | Field `executionOwnerToken` on this DTO (see source semantics). |
| `expectedExecutionOwnerToken` | `string \| null` | no | Consumer caller | Module lifecycle | Field `expectedExecutionOwnerToken` on this DTO (see source semantics). |
| `reason` | `string` | yes | Consumer caller | Module lifecycle | Field `reason` on this DTO (see source semantics). |

#### `UpdatePaymentOperationInput`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `operationId` | `string` | yes | Module lifecycle | Module lifecycle | Field `operationId` on this DTO (see source semantics). |
| `expectedVersion` | `number` | yes | Consumer caller | Module lifecycle | Field `expectedVersion` on this DTO (see source semantics). |
| `approvalUrl` | `string \| null` | no | Consumer caller | Module lifecycle | Field `approvalUrl` on this DTO (see source semantics). |
| `amountMinor` | `string \| null` | no | Consumer caller | Module lifecycle | Integer minor units as decimal string (see CanonicalMoney). |
| `currencyCode` | `string \| null` | no | Consumer caller | Module lifecycle | ISO currency code paired with amountMinor on store rows. |
| `providerOrderId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerOrderId` on this DTO (see source semantics). |
| `providerCaptureId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerCaptureId` on this DTO (see source semantics). |
| `providerRefundId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerRefundId` on this DTO (see source semantics). |
| `providerReferenceId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerReferenceId` on this DTO (see source semantics). |
| `senderBatchId` | `string \| null` | no | Consumer caller | Module lifecycle | Field `senderBatchId` on this DTO (see source semantics). |
| `senderItemId` | `string \| null` | no | Consumer caller | Module lifecycle | Field `senderItemId` on this DTO (see source semantics). |
| `providerPayoutBatchId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerPayoutBatchId` on this DTO (see source semantics). |
| `providerPayoutItemId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerPayoutItemId` on this DTO (see source semantics). |
| `payoutStatus` | `PayoutFinancialStatus \| null` | no | Consumer caller | Module lifecycle | Field `payoutStatus` on this DTO (see source semantics). |
| `recipientType` | `PayoutRecipientType \| null` | no | Consumer caller | Module lifecycle | Field `recipientType` on this DTO (see source semantics). |
| `maskedDestination` | `string \| null` | no | Consumer caller | Module lifecycle | Field `maskedDestination` on this DTO (see source semantics). |
| `recipientValue` | `string \| null` | no | Consumer caller | Module lifecycle | Field `recipientValue` on this DTO (see source semantics). |
| `providerTransactionId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerTransactionId` on this DTO (see source semantics). |
| `providerFeeMinor` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerFeeMinor` on this DTO (see source semantics). |
| `providerFeeCurrency` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerFeeCurrency` on this DTO (see source semantics). |
| `itemRef` | `string \| null` | no | Consumer caller | Module lifecycle | Field `itemRef` on this DTO (see source semantics). |
| `productStatus` | `ProductStatus \| null` | no | Consumer caller | Module lifecycle | Field `productStatus` on this DTO (see source semantics). |
| `planStatus` | `PlanStatus \| null` | no | Consumer caller | Module lifecycle | Field `planStatus` on this DTO (see source semantics). |
| `subscriptionStatus` | `SubscriptionStatus \| null` | no | Consumer caller | Module lifecycle | Field `subscriptionStatus` on this DTO (see source semantics). |
| `providerProductId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerProductId` on this DTO (see source semantics). |
| `providerPlanId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerPlanId` on this DTO (see source semantics). |
| `providerSubscriptionId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerSubscriptionId` on this DTO (see source semantics). |
| `offeringRef` | `string \| null` | no | Consumer caller | Module lifecycle | Field `offeringRef` on this DTO (see source semantics). |
| `maskedSubscriber` | `string \| null` | no | Consumer caller | Module lifecycle | Field `maskedSubscriber` on this DTO (see source semantics). |
| `subscriberRef` | `string \| null` | no | Consumer caller | Module lifecycle | Field `subscriberRef` on this DTO (see source semantics). |
| `subscriberEmail` | `string \| null` | no | Consumer caller | Module lifecycle | Field `subscriberEmail` on this DTO (see source semantics). |
| `startTime` | `string \| null` | no | Consumer caller | Module lifecycle | Field `startTime` on this DTO (see source semantics). |
| `nextBillingTime` | `string \| null` | no | Consumer caller | Module lifecycle | Field `nextBillingTime` on this DTO (see source semantics). |
| `lifecycleReason` | `string \| null` | no | Consumer caller | Module lifecycle | Field `lifecycleReason` on this DTO (see source semantics). |
| `providerSubscriptionStateAt` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerSubscriptionStateAt` on this DTO (see source semantics). |
| `sellerRef` | `string \| null` | no | Consumer caller | Module lifecycle | Field `sellerRef` on this DTO (see source semantics). |
| `providerReferralId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerReferralId` on this DTO (see source semantics). |

### `payout.ts`

#### `PayoutProviderContext`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module persistence + reconciliation | Field `providerCode` on this DTO (see source semantics). |
| `accountRef` | `string` | yes | Consumer caller | Module lifecycle | Field `accountRef` on this DTO (see source semantics). |
| `applicationRef` | `string` | yes | Consumer caller | Module lifecycle | Field `applicationRef` on this DTO (see source semantics). |
| `environment` | `PaymentEnvironment` | yes | Consumer caller | Module lifecycle | Field `environment` on this DTO (see source semantics). |

#### `PayoutRecipientInput`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `recipientType` | `PayoutRecipientType` | yes | Consumer caller | Module lifecycle | Field `recipientType` on this DTO (see source semantics). |
| `receiver` | `string` | yes | Consumer caller | Module lifecycle | Field `receiver` on this DTO (see source semantics). |
| `note` | `string \| null` | no | Consumer caller | Module lifecycle | Field `note` on this DTO (see source semantics). |
| `purpose` | `string \| null` | no | Consumer caller | Module lifecycle | Field `purpose` on this DTO (see source semantics). |

#### `SubmitPayoutBatchItemInput`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `itemRef` | `string` | yes | Consumer caller | Module lifecycle | Field `itemRef` on this DTO (see source semantics). |
| `amount` | `CanonicalMoney` | yes | Consumer caller | Module lifecycle | Field `amount` on this DTO (see source semantics). |
| `recipient` | `PayoutRecipientInput` | yes | Consumer caller | Module lifecycle | Field `recipient` on this DTO (see source semantics). |

#### `SubmitPayoutBatchRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `idempotencyKey` | `string` | yes | Consumer caller | Module store | Command deduplication key within idempotency scope. |
| `correlationId` | `string \| null` | no | Consumer caller | Module store | Optional consumer tracing reference stored on the operation. |
| `emailSubject` | `string \| null` | no | Consumer caller | Module lifecycle | Field `emailSubject` on this DTO (see source semantics). |
| `emailMessage` | `string \| null` | no | Consumer caller | Module lifecycle | Field `emailMessage` on this DTO (see source semantics). |
| `items` | `SubmitPayoutBatchItemInput[]` | yes | Consumer caller | Module lifecycle | Field `items` on this DTO (see source semantics). |

#### `PayoutBatchItemResult`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `itemOperationId` | `string` | yes | Module lifecycle | Module lifecycle | Field `itemOperationId` on this DTO (see source semantics). |
| `itemRef` | `string` | yes | Consumer caller | Module lifecycle | Field `itemRef` on this DTO (see source semantics). |
| `operationStatus` | `PaymentOperationStatus` | yes | Consumer caller | Module lifecycle | Field `operationStatus` on this DTO (see source semantics). |
| `payoutStatus` | `PayoutFinancialStatus` | yes | Consumer caller | Module lifecycle | Field `payoutStatus` on this DTO (see source semantics). |
| `senderItemId` | `string` | yes | Consumer caller | Module lifecycle | Field `senderItemId` on this DTO (see source semantics). |
| `providerPayoutItemId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerPayoutItemId` on this DTO (see source semantics). |
| `amount` | `CanonicalMoney` | yes | Consumer caller | Module lifecycle | Field `amount` on this DTO (see source semantics). |
| `maskedDestination` | `string` | yes | Consumer caller | Module lifecycle | Field `maskedDestination` on this DTO (see source semantics). |
| `providerTransactionId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerTransactionId` on this DTO (see source semantics). |
| `providerFee` | `CanonicalMoney \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerFee` on this DTO (see source semantics). |
| `failureCode` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `failureCode` on this DTO (see source semantics). |
| `failureMessage` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `failureMessage` on this DTO (see source semantics). |

#### `SubmitPayoutBatchResult`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `batchOperationId` | `string` | yes | Module lifecycle | Module lifecycle | Field `batchOperationId` on this DTO (see source semantics). |
| `operationStatus` | `PaymentOperationStatus` | yes | Consumer caller | Module lifecycle | Field `operationStatus` on this DTO (see source semantics). |
| `payoutStatus` | `PayoutFinancialStatus` | yes | Consumer caller | Module lifecycle | Field `payoutStatus` on this DTO (see source semantics). |
| `senderBatchId` | `string` | yes | Consumer caller | Module lifecycle | Field `senderBatchId` on this DTO (see source semantics). |
| `providerPayoutBatchId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerPayoutBatchId` on this DTO (see source semantics). |
| `itemCount` | `number` | yes | Consumer caller | Module lifecycle | Field `itemCount` on this DTO (see source semantics). |
| `totalsByCurrency` | `Record<string, string>` | yes | Consumer caller | Module lifecycle | Field `totalsByCurrency` on this DTO (see source semantics). |
| `items` | `PayoutBatchItemResult[]` | yes | Consumer caller | Module lifecycle | Field `items` on this DTO (see source semantics). |
| `correlationId` | `string \| null` | yes | Consumer caller | Module store | Optional consumer tracing reference stored on the operation. |
| `providerDebugId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerDebugId` on this DTO (see source semantics). |

#### `GetPayoutBatchRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `batchOperationId` | `string` | yes | Module lifecycle | Module lifecycle | Field `batchOperationId` on this DTO (see source semantics). |

#### `GetPayoutItemRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `itemOperationId` | `string` | yes | Module lifecycle | Module lifecycle | Field `itemOperationId` on this DTO (see source semantics). |

#### `GetPayoutItemResult`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `batchOperationId` | `string` | yes | Module lifecycle | Module lifecycle | Field `batchOperationId` on this DTO (see source semantics). |
| `senderBatchId` | `string` | yes | Consumer caller | Module lifecycle | Field `senderBatchId` on this DTO (see source semantics). |
| `providerPayoutBatchId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerPayoutBatchId` on this DTO (see source semantics). |
| `correlationId` | `string \| null` | yes | Consumer caller | Module store | Optional consumer tracing reference stored on the operation. |

#### `CancelUnclaimedPayoutItemRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `itemOperationId` | `string` | yes | Module lifecycle | Module lifecycle | Field `itemOperationId` on this DTO (see source semantics). |

#### `ExecuteSubmitPayoutBatchRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `providerRequestId` | `string` | yes | Provider adapter / module | Provider port implementation | Module-generated idempotency token for a single provider HTTP attempt. |
| `senderBatchId` | `string` | yes | Consumer caller | Module lifecycle | Field `senderBatchId` on this DTO (see source semantics). |
| `emailSubject` | `string \| null` | no | Consumer caller | Module lifecycle | Field `emailSubject` on this DTO (see source semantics). |
| `emailMessage` | `string \| null` | no | Consumer caller | Module lifecycle | Field `emailMessage` on this DTO (see source semantics). |
| `items` | `Array<{` | yes | Consumer caller | Module lifecycle | Field `items` on this DTO (see source semantics). |
| `senderItemId` | `string` | yes | Consumer caller | Module lifecycle | Field `senderItemId` on this DTO (see source semantics). |
| `amount` | `CanonicalMoney` | yes | Consumer caller | Module lifecycle | Field `amount` on this DTO (see source semantics). |
| `recipientType` | `PayoutRecipientType` | yes | Consumer caller | Module lifecycle | Field `recipientType` on this DTO (see source semantics). |
| `receiver` | `string` | yes | Consumer caller | Module lifecycle | Field `receiver` on this DTO (see source semantics). |
| `note` | `string \| null` | no | Consumer caller | Module lifecycle | Field `note` on this DTO (see source semantics). |
| `purpose` | `string \| null` | no | Consumer caller | Module lifecycle | Field `purpose` on this DTO (see source semantics). |

#### `ExecuteSubmitPayoutBatchResult`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `senderBatchId` | `string` | yes | Consumer caller | Module lifecycle | Field `senderBatchId` on this DTO (see source semantics). |
| `providerPayoutBatchId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerPayoutBatchId` on this DTO (see source semantics). |
| `batchPayoutStatus` | `PayoutFinancialStatus` | yes | Consumer caller | Module lifecycle | Field `batchPayoutStatus` on this DTO (see source semantics). |
| `items` | `Array<{` | yes | Consumer caller | Module lifecycle | Field `items` on this DTO (see source semantics). |
| `senderItemId` | `string` | yes | Consumer caller | Module lifecycle | Field `senderItemId` on this DTO (see source semantics). |
| `providerPayoutItemId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerPayoutItemId` on this DTO (see source semantics). |
| `payoutStatus` | `PayoutFinancialStatus` | yes | Consumer caller | Module lifecycle | Field `payoutStatus` on this DTO (see source semantics). |
| `providerTransactionId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerTransactionId` on this DTO (see source semantics). |
| `providerFee` | `CanonicalMoney \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerFee` on this DTO (see source semantics). |
| `failureCode` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `failureCode` on this DTO (see source semantics). |
| `failureMessage` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `failureMessage` on this DTO (see source semantics). |
| `providerDebugId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerDebugId` on this DTO (see source semantics). |

#### `ExecuteGetPayoutBatchRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `providerPayoutBatchId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerPayoutBatchId` on this DTO (see source semantics). |

#### `ExecuteGetPayoutBatchResult`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerPayoutBatchId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerPayoutBatchId` on this DTO (see source semantics). |
| `senderBatchId` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `senderBatchId` on this DTO (see source semantics). |
| `batchPayoutStatus` | `PayoutFinancialStatus` | yes | Consumer caller | Module lifecycle | Field `batchPayoutStatus` on this DTO (see source semantics). |
| `items` | `Array<{` | yes | Consumer caller | Module lifecycle | Field `items` on this DTO (see source semantics). |
| `providerPayoutItemId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerPayoutItemId` on this DTO (see source semantics). |
| `senderItemId` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `senderItemId` on this DTO (see source semantics). |
| `payoutStatus` | `PayoutFinancialStatus` | yes | Consumer caller | Module lifecycle | Field `payoutStatus` on this DTO (see source semantics). |
| `amount` | `CanonicalMoney \| null` | yes | Consumer caller | Module lifecycle | Field `amount` on this DTO (see source semantics). |
| `providerTransactionId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerTransactionId` on this DTO (see source semantics). |
| `providerFee` | `CanonicalMoney \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerFee` on this DTO (see source semantics). |
| `failureCode` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `failureCode` on this DTO (see source semantics). |
| `failureMessage` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `failureMessage` on this DTO (see source semantics). |
| `providerDebugId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerDebugId` on this DTO (see source semantics). |

#### `ExecuteGetPayoutItemRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `providerPayoutItemId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerPayoutItemId` on this DTO (see source semantics). |

#### `ExecuteGetPayoutItemResult`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerPayoutItemId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerPayoutItemId` on this DTO (see source semantics). |
| `providerPayoutBatchId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerPayoutBatchId` on this DTO (see source semantics). |
| `senderBatchId` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `senderBatchId` on this DTO (see source semantics). |
| `senderItemId` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `senderItemId` on this DTO (see source semantics). |
| `payoutStatus` | `PayoutFinancialStatus` | yes | Consumer caller | Module lifecycle | Field `payoutStatus` on this DTO (see source semantics). |
| `amount` | `CanonicalMoney \| null` | yes | Consumer caller | Module lifecycle | Field `amount` on this DTO (see source semantics). |
| `providerTransactionId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerTransactionId` on this DTO (see source semantics). |
| `providerFee` | `CanonicalMoney \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerFee` on this DTO (see source semantics). |
| `failureCode` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `failureCode` on this DTO (see source semantics). |
| `failureMessage` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `failureMessage` on this DTO (see source semantics). |
| `providerDebugId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerDebugId` on this DTO (see source semantics). |

#### `ExecuteCancelUnclaimedPayoutItemRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `providerPayoutItemId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerPayoutItemId` on this DTO (see source semantics). |

### `recovery.ts`

#### `ClaimPendingEvidenceInput`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `limit` | `number` | yes | Consumer caller | Module lifecycle | Maximum rows or candidates processed in one batch. |
| `leaseMs` | `number` | yes | Consumer caller | Module lifecycle | Claim lease duration in milliseconds. |
| `workerId` | `string` | yes | Consumer caller | Module lifecycle | Recovery/reconciliation worker identity for claim leases. |
| `evidenceIds` | `string[]` | no | Consumer caller | Module lifecycle | Field `evidenceIds` on this DTO (see source semantics). |
| `environment` | `PaymentEnvironment` | no | Consumer caller | Module lifecycle | Field `environment` on this DTO (see source semantics). |
| `providerCode` | `string` | no | Consumer caller | Module persistence + reconciliation | Field `providerCode` on this DTO (see source semantics). |
| `accountRef` | `string` | no | Consumer caller | Module lifecycle | Field `accountRef` on this DTO (see source semantics). |

#### `RecoverPaymentReliabilityInput`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `limit` | `number` | no | Consumer caller | Module lifecycle | Maximum rows or candidates processed in one batch. |
| `workerId` | `string` | yes | Consumer caller | Module lifecycle | Recovery/reconciliation worker identity for claim leases. |
| `leaseMs` | `number` | no | Consumer caller | Module lifecycle | Claim lease duration in milliseconds. |
| `environment` | `PaymentEnvironment` | no | Consumer caller | Module lifecycle | Field `environment` on this DTO (see source semantics). |
| `providerCode` | `string` | no | Consumer caller | Module persistence + reconciliation | Field `providerCode` on this DTO (see source semantics). |
| `accountRef` | `string` | no | Consumer caller | Module lifecycle | Field `accountRef` on this DTO (see source semantics). |
| `evidenceIds` | `string[]` | no | Consumer caller | Module lifecycle | Field `evidenceIds` on this DTO (see source semantics). |

#### `RecoverPaymentReliabilityResult`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `claimed` | `number` | yes | Consumer caller | Module lifecycle | Field `claimed` on this DTO (see source semantics). |
| `verified` | `number` | yes | Consumer caller | Module lifecycle | Field `verified` on this DTO (see source semantics). |
| `processed` | `number` | yes | Consumer caller | Module lifecycle | Field `processed` on this DTO (see source semantics). |
| `delivered` | `number` | yes | Consumer caller | Module lifecycle | Field `delivered` on this DTO (see source semantics). |
| `skipped` | `number` | yes | Consumer caller | Module lifecycle | Field `skipped` on this DTO (see source semantics). |
| `failed` | `number` | yes | Consumer caller | Module lifecycle | Field `failed` on this DTO (see source semantics). |

#### `RecoverPaymentEvidenceInput`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `evidenceId` | `string` | yes | Consumer caller | Module lifecycle | Field `evidenceId` on this DTO (see source semantics). |
| `workerId` | `string` | yes | Consumer caller | Module lifecycle | Recovery/reconciliation worker identity for claim leases. |
| `leaseMs` | `number` | no | Consumer caller | Module lifecycle | Claim lease duration in milliseconds. |
| `environment` | `PaymentEnvironment` | yes | Consumer caller | Module lifecycle | Field `environment` on this DTO (see source semantics). |

#### `RecoverPaymentEvidenceResult`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `evidenceId` | `string` | yes | Consumer caller | Module lifecycle | Field `evidenceId` on this DTO (see source semantics). |

#### `ListPaymentEvidenceForRecoveryInput`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `environment` | `PaymentEnvironment` | yes | Consumer caller | Module lifecycle | Field `environment` on this DTO (see source semantics). |
| `providerCode` | `string` | no | Consumer caller | Module persistence + reconciliation | Field `providerCode` on this DTO (see source semantics). |
| `accountRef` | `string` | no | Consumer caller | Module lifecycle | Field `accountRef` on this DTO (see source semantics). |
| `limit` | `number` | no | Consumer caller | Module lifecycle | Maximum rows or candidates processed in one batch. |
| `offset` | `number` | no | Consumer caller | Module lifecycle | Field `offset` on this DTO (see source semantics). |
| `recoverableOnly` | `boolean` | no | Consumer caller | Module lifecycle | Field `recoverableOnly` on this DTO (see source semantics). |

#### `PaymentEvidenceAdminView`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `evidenceId` | `string` | yes | Consumer caller | Module lifecycle | Field `evidenceId` on this DTO (see source semantics). |
| `providerCode` | `string` | yes | Consumer caller | Module persistence + reconciliation | Field `providerCode` on this DTO (see source semantics). |
| `accountRef` | `string` | yes | Consumer caller | Module lifecycle | Field `accountRef` on this DTO (see source semantics). |
| `applicationRef` | `string` | yes | Consumer caller | Module lifecycle | Field `applicationRef` on this DTO (see source semantics). |
| `environment` | `PaymentEnvironment` | yes | Consumer caller | Module lifecycle | Field `environment` on this DTO (see source semantics). |
| `providerEventId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerEventId` on this DTO (see source semantics). |
| `relatedOperationId` | `string \| null` | yes | Module lifecycle | Module lifecycle | Field `relatedOperationId` on this DTO (see source semantics). |
| `receivedAt` | `string` | yes | Consumer caller | Module lifecycle | Field `receivedAt` on this DTO (see source semantics). |
| `verificationStatus` | `string` | yes | Consumer caller | Module lifecycle | Field `verificationStatus` on this DTO (see source semantics). |
| `processingStatus` | `string` | yes | Consumer caller | Module lifecycle | Field `processingStatus` on this DTO (see source semantics). |
| `consumerDeliveryStatus` | `string` | no | Consumer caller | Module lifecycle | Field `consumerDeliveryStatus` on this DTO (see source semantics). |
| `consumerDeliveredAt` | `string \| null` | no | Consumer caller | Module lifecycle | Field `consumerDeliveredAt` on this DTO (see source semantics). |
| `consumerDeliveryAttempts` | `number` | no | Consumer caller | Module lifecycle | Field `consumerDeliveryAttempts` on this DTO (see source semantics). |
| `consumerDeliveryLastError` | `string \| null` | no | Consumer caller | Module lifecycle | Field `consumerDeliveryLastError` on this DTO (see source semantics). |
| `eventType` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `eventType` on this DTO (see source semantics). |
| `resourceId` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `resourceId` on this DTO (see source semantics). |
| `errorCode` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `errorCode` on this DTO (see source semantics). |
| `errorMessage` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `errorMessage` on this DTO (see source semantics). |
| `processedAt` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `processedAt` on this DTO (see source semantics). |
| `updatedAt` | `string` | yes | Consumer caller | Module lifecycle | Field `updatedAt` on this DTO (see source semantics). |

### `refund.ts`

#### `RefundCaptureRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module persistence + reconciliation | Field `providerCode` on this DTO (see source semantics). |
| `accountRef` | `string` | yes | Consumer caller | Module lifecycle | Field `accountRef` on this DTO (see source semantics). |
| `applicationRef` | `string` | yes | Consumer caller | Module lifecycle | Field `applicationRef` on this DTO (see source semantics). |
| `environment` | `PaymentEnvironment` | yes | Consumer caller | Module lifecycle | Field `environment` on this DTO (see source semantics). |
| `idempotencyKey` | `string` | yes | Consumer caller | Module store | Command deduplication key within idempotency scope. |
| `correlationId` | `string \| null` | no | Consumer caller | Module store | Optional consumer tracing reference stored on the operation. |
| `captureOperationId` | `string` | yes | Module lifecycle | Module lifecycle | Field `captureOperationId` on this DTO (see source semantics). |
| `providerCaptureId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerCaptureId` on this DTO (see source semantics). |
| `amount` | `CanonicalMoney \| null` | no | Consumer caller | Module lifecycle | Field `amount` on this DTO (see source semantics). |

#### `RefundCaptureResult`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `operationId` | `string` | yes | Module lifecycle | Module lifecycle | Field `operationId` on this DTO (see source semantics). |
| `operationStatus` | `PaymentOperationStatus` | yes | Consumer caller | Module lifecycle | Field `operationStatus` on this DTO (see source semantics). |
| `captureOperationId` | `string` | yes | Module lifecycle | Module lifecycle | Field `captureOperationId` on this DTO (see source semantics). |
| `providerCaptureId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerCaptureId` on this DTO (see source semantics). |
| `providerRefundId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerRefundId` on this DTO (see source semantics). |
| `refundStatus` | `RefundStatus` | yes | Consumer caller | Module lifecycle | Field `refundStatus` on this DTO (see source semantics). |
| `amount` | `CanonicalMoney \| null` | yes | Consumer caller | Module lifecycle | Field `amount` on this DTO (see source semantics). |
| `correlationId` | `string \| null` | yes | Consumer caller | Module store | Optional consumer tracing reference stored on the operation. |
| `providerDebugId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerDebugId` on this DTO (see source semantics). |

#### `ExecuteRefundCaptureRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module persistence + reconciliation | Field `providerCode` on this DTO (see source semantics). |
| `accountRef` | `string` | yes | Consumer caller | Module lifecycle | Field `accountRef` on this DTO (see source semantics). |
| `applicationRef` | `string` | yes | Consumer caller | Module lifecycle | Field `applicationRef` on this DTO (see source semantics). |
| `environment` | `PaymentEnvironment` | yes | Consumer caller | Module lifecycle | Field `environment` on this DTO (see source semantics). |
| `providerRequestId` | `string` | yes | Provider adapter / module | Provider port implementation | Module-generated idempotency token for a single provider HTTP attempt. |
| `providerCaptureId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerCaptureId` on this DTO (see source semantics). |
| `amount` | `CanonicalMoney \| null` | no | Consumer caller | Module lifecycle | Field `amount` on this DTO (see source semantics). |

#### `ExecuteRefundCaptureResult`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerRefundId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerRefundId` on this DTO (see source semantics). |
| `refundStatus` | `RefundStatus` | yes | Consumer caller | Module lifecycle | Field `refundStatus` on this DTO (see source semantics). |
| `amount` | `CanonicalMoney \| null` | yes | Consumer caller | Module lifecycle | Field `amount` on this DTO (see source semantics). |
| `providerDebugId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerDebugId` on this DTO (see source semantics). |

#### `ExecuteGetRefundRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module persistence + reconciliation | Field `providerCode` on this DTO (see source semantics). |
| `accountRef` | `string` | yes | Consumer caller | Module lifecycle | Field `accountRef` on this DTO (see source semantics). |
| `applicationRef` | `string` | yes | Consumer caller | Module lifecycle | Field `applicationRef` on this DTO (see source semantics). |
| `environment` | `PaymentEnvironment` | yes | Consumer caller | Module lifecycle | Field `environment` on this DTO (see source semantics). |
| `providerRefundId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerRefundId` on this DTO (see source semantics). |

### `seller-onboarding.ts`

#### `SellerOnboardingProviderContext`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module persistence + reconciliation | Field `providerCode` on this DTO (see source semantics). |
| `accountRef` | `string` | yes | Consumer caller | Module lifecycle | Field `accountRef` on this DTO (see source semantics). |
| `applicationRef` | `string` | yes | Consumer caller | Module lifecycle | Field `applicationRef` on this DTO (see source semantics). |
| `environment` | `PaymentEnvironment` | yes | Consumer caller | Module lifecycle | Field `environment` on this DTO (see source semantics). |

#### `SellerConnectionReadinessChecks`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `merchantIdentityPresent` | `boolean` | yes | Consumer caller | Module lifecycle | Field `merchantIdentityPresent` on this DTO (see source semantics). |
| `onboardingCompleted` | `boolean` | yes | Consumer caller | Module lifecycle | Field `onboardingCompleted` on this DTO (see source semantics). |
| `consentGranted` | `boolean` | yes | Consumer caller | Module lifecycle | Field `consentGranted` on this DTO (see source semantics). |
| `requiredPermissionsGranted` | `boolean` | yes | Consumer caller | Module lifecycle | Field `requiredPermissionsGranted` on this DTO (see source semantics). |
| `paymentsReceivable` | `boolean` | yes | Consumer caller | Module lifecycle | Field `paymentsReceivable` on this DTO (see source semantics). |
| `primaryEmailConfirmed` | `boolean` | yes | Consumer caller | Module lifecycle | Field `primaryEmailConfirmed` on this DTO (see source semantics). |
| `notRevoked` | `boolean` | yes | Consumer caller | Module lifecycle | Field `notRevoked` on this DTO (see source semantics). |
| `notRestricted` | `boolean` | yes | Consumer caller | Module lifecycle | Field `notRestricted` on this DTO (see source semantics). |

#### `SellerConnectionReadiness`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `ready` | `boolean` | yes | Consumer caller | Module lifecycle | Field `ready` on this DTO (see source semantics). |
| `reasons` | `string[]` | yes | Consumer caller | Module lifecycle | Field `reasons` on this DTO (see source semantics). |
| `checks` | `SellerConnectionReadinessChecks` | yes | Consumer caller | Module lifecycle | Field `checks` on this DTO (see source semantics). |

#### `SellerConnectionRecord`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `connectionId` | `string` | yes | Consumer caller | Module lifecycle | Field `connectionId` on this DTO (see source semantics). |
| `applicationRef` | `string` | yes | Consumer caller | Module lifecycle | Field `applicationRef` on this DTO (see source semantics). |
| `providerCode` | `string` | yes | Consumer caller | Module persistence + reconciliation | Field `providerCode` on this DTO (see source semantics). |
| `accountRef` | `string` | yes | Consumer caller | Module lifecycle | Field `accountRef` on this DTO (see source semantics). |
| `environment` | `PaymentEnvironment` | yes | Consumer caller | Module lifecycle | Field `environment` on this DTO (see source semantics). |
| `sellerRef` | `string` | yes | Consumer caller | Module lifecycle | Field `sellerRef` on this DTO (see source semantics). |
| `trackingId` | `string` | yes | Consumer caller | Module lifecycle | Field `trackingId` on this DTO (see source semantics). |
| `latestReferralOperationId` | `string \| null` | yes | Module lifecycle | Module lifecycle | Field `latestReferralOperationId` on this DTO (see source semantics). |
| `providerReferralId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerReferralId` on this DTO (see source semantics). |
| `providerMerchantId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerMerchantId` on this DTO (see source semantics). |
| `connectionStatus` | `SellerConnectionStatus` | yes | Consumer caller | Module lifecycle | Field `connectionStatus` on this DTO (see source semantics). |
| `consentStatus` | `SellerConsentStatus` | yes | Consumer caller | Module lifecycle | Field `consentStatus` on this DTO (see source semantics). |
| `paymentsReceivable` | `boolean \| null` | yes | Consumer caller | Module lifecycle | Field `paymentsReceivable` on this DTO (see source semantics). |
| `primaryEmailConfirmed` | `boolean \| null` | yes | Consumer caller | Module lifecycle | Field `primaryEmailConfirmed` on this DTO (see source semantics). |
| `requiredPermissionsGranted` | `boolean \| null` | yes | Consumer caller | Module lifecycle | Field `requiredPermissionsGranted` on this DTO (see source semantics). |
| `onboardingCompleted` | `boolean` | yes | Consumer caller | Module lifecycle | Field `onboardingCompleted` on this DTO (see source semantics). |
| `restricted` | `boolean` | yes | Consumer caller | Module lifecycle | Field `restricted` on this DTO (see source semantics). |
| `readinessReady` | `boolean` | yes | Consumer caller | Module lifecycle | Field `readinessReady` on this DTO (see source semantics). |
| `readinessReasons` | `string[]` | yes | Consumer caller | Module lifecycle | Field `readinessReasons` on this DTO (see source semantics). |
| `normalizedCapabilities` | `Record<string, boolean>` | yes | Consumer caller | Module lifecycle | Field `normalizedCapabilities` on this DTO (see source semantics). |
| `version` | `number` | yes | Consumer caller | Module lifecycle | Field `version` on this DTO (see source semantics). |
| `createdAt` | `string` | yes | Consumer caller | Module lifecycle | Field `createdAt` on this DTO (see source semantics). |
| `updatedAt` | `string` | yes | Consumer caller | Module lifecycle | Field `updatedAt` on this DTO (see source semantics). |

#### `CreateSellerConnectionInput`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `applicationRef` | `string` | yes | Consumer caller | Module lifecycle | Field `applicationRef` on this DTO (see source semantics). |
| `providerCode` | `string` | yes | Consumer caller | Module persistence + reconciliation | Field `providerCode` on this DTO (see source semantics). |
| `accountRef` | `string` | yes | Consumer caller | Module lifecycle | Field `accountRef` on this DTO (see source semantics). |
| `environment` | `PaymentEnvironment` | yes | Consumer caller | Module lifecycle | Field `environment` on this DTO (see source semantics). |
| `sellerRef` | `string` | yes | Consumer caller | Module lifecycle | Field `sellerRef` on this DTO (see source semantics). |
| `trackingId` | `string` | yes | Consumer caller | Module lifecycle | Field `trackingId` on this DTO (see source semantics). |
| `latestReferralOperationId` | `string \| null` | no | Module lifecycle | Module lifecycle | Field `latestReferralOperationId` on this DTO (see source semantics). |
| `providerReferralId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerReferralId` on this DTO (see source semantics). |

#### `UpdateSellerConnectionInput`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `connectionId` | `string` | yes | Consumer caller | Module lifecycle | Field `connectionId` on this DTO (see source semantics). |
| `expectedVersion` | `number` | yes | Consumer caller | Module lifecycle | Field `expectedVersion` on this DTO (see source semantics). |
| `latestReferralOperationId` | `string \| null` | no | Module lifecycle | Module lifecycle | Field `latestReferralOperationId` on this DTO (see source semantics). |
| `providerReferralId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerReferralId` on this DTO (see source semantics). |
| `providerMerchantId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerMerchantId` on this DTO (see source semantics). |
| `connectionStatus` | `SellerConnectionStatus` | no | Consumer caller | Module lifecycle | Field `connectionStatus` on this DTO (see source semantics). |
| `consentStatus` | `SellerConsentStatus` | no | Consumer caller | Module lifecycle | Field `consentStatus` on this DTO (see source semantics). |
| `paymentsReceivable` | `boolean \| null` | no | Consumer caller | Module lifecycle | Field `paymentsReceivable` on this DTO (see source semantics). |
| `primaryEmailConfirmed` | `boolean \| null` | no | Consumer caller | Module lifecycle | Field `primaryEmailConfirmed` on this DTO (see source semantics). |
| `requiredPermissionsGranted` | `boolean \| null` | no | Consumer caller | Module lifecycle | Field `requiredPermissionsGranted` on this DTO (see source semantics). |
| `onboardingCompleted` | `boolean` | no | Consumer caller | Module lifecycle | Field `onboardingCompleted` on this DTO (see source semantics). |
| `restricted` | `boolean` | no | Consumer caller | Module lifecycle | Field `restricted` on this DTO (see source semantics). |
| `readinessReady` | `boolean` | no | Consumer caller | Module lifecycle | Field `readinessReady` on this DTO (see source semantics). |
| `readinessReasons` | `string[]` | no | Consumer caller | Module lifecycle | Field `readinessReasons` on this DTO (see source semantics). |
| `normalizedCapabilities` | `Record<string, boolean>` | no | Consumer caller | Module lifecycle | Field `normalizedCapabilities` on this DTO (see source semantics). |

#### `CreateSellerReferralRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `idempotencyKey` | `string` | yes | Consumer caller | Module store | Command deduplication key within idempotency scope. |
| `sellerRef` | `string` | yes | Consumer caller | Module lifecycle | Field `sellerRef` on this DTO (see source semantics). |
| `correlationId` | `string \| null` | no | Consumer caller | Module store | Optional consumer tracing reference stored on the operation. |

#### `SellerReferralResult`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `referralOperationId` | `string` | yes | Module lifecycle | Module lifecycle | Field `referralOperationId` on this DTO (see source semantics). |
| `connectionId` | `string` | yes | Consumer caller | Module lifecycle | Field `connectionId` on this DTO (see source semantics). |
| `operationStatus` | `PaymentOperationStatus` | yes | Consumer caller | Module lifecycle | Field `operationStatus` on this DTO (see source semantics). |
| `connectionStatus` | `SellerConnectionStatus` | yes | Consumer caller | Module lifecycle | Field `connectionStatus` on this DTO (see source semantics). |
| `providerReferralId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerReferralId` on this DTO (see source semantics). |
| `actionUrl` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `actionUrl` on this DTO (see source semantics). |
| `sellerRef` | `string` | yes | Consumer caller | Module lifecycle | Field `sellerRef` on this DTO (see source semantics). |
| `correlationId` | `string \| null` | yes | Consumer caller | Module store | Optional consumer tracing reference stored on the operation. |
| `providerDebugId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerDebugId` on this DTO (see source semantics). |

#### `GetSellerReferralRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `referralOperationId` | `string` | yes | Module lifecycle | Module lifecycle | Field `referralOperationId` on this DTO (see source semantics). |

#### `GetSellerConnectionRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `sellerRef` | `string` | yes | Consumer caller | Module lifecycle | Field `sellerRef` on this DTO (see source semantics). |

#### `SellerConnectionResult`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `connectionId` | `string` | yes | Consumer caller | Module lifecycle | Field `connectionId` on this DTO (see source semantics). |
| `sellerRef` | `string` | yes | Consumer caller | Module lifecycle | Field `sellerRef` on this DTO (see source semantics). |
| `trackingId` | `string` | yes | Consumer caller | Module lifecycle | Field `trackingId` on this DTO (see source semantics). |
| `providerReferralId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerReferralId` on this DTO (see source semantics). |
| `providerMerchantId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerMerchantId` on this DTO (see source semantics). |
| `connectionStatus` | `SellerConnectionStatus` | yes | Consumer caller | Module lifecycle | Field `connectionStatus` on this DTO (see source semantics). |
| `consentStatus` | `SellerConsentStatus` | yes | Consumer caller | Module lifecycle | Field `consentStatus` on this DTO (see source semantics). |
| `readiness` | `SellerConnectionReadiness` | yes | Consumer caller | Module lifecycle | Field `readiness` on this DTO (see source semantics). |
| `latestReferralOperationId` | `string \| null` | yes | Module lifecycle | Module lifecycle | Field `latestReferralOperationId` on this DTO (see source semantics). |

#### `ReconcileSellerConnectionRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `sellerRef` | `string` | yes | Consumer caller | Module lifecycle | Field `sellerRef` on this DTO (see source semantics). |

#### `ExecuteCreateSellerReferralRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `providerRequestId` | `string` | yes | Provider adapter / module | Provider port implementation | Module-generated idempotency token for a single provider HTTP attempt. |
| `trackingId` | `string` | yes | Consumer caller | Module lifecycle | Field `trackingId` on this DTO (see source semantics). |

#### `ExecuteCreateSellerReferralResult`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerReferralId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerReferralId` on this DTO (see source semantics). |
| `actionUrl` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `actionUrl` on this DTO (see source semantics). |
| `providerDebugId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerDebugId` on this DTO (see source semantics). |

#### `ExecuteGetSellerReferralRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `providerReferralId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerReferralId` on this DTO (see source semantics). |

#### `ExecuteGetSellerReferralResult`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerReferralId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerReferralId` on this DTO (see source semantics). |
| `actionUrl` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `actionUrl` on this DTO (see source semantics). |
| `providerDebugId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerDebugId` on this DTO (see source semantics). |

#### `ExecuteFindSellerMerchantRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `trackingId` | `string` | yes | Consumer caller | Module lifecycle | Field `trackingId` on this DTO (see source semantics). |

#### `ExecuteFindSellerMerchantResult`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerMerchantId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerMerchantId` on this DTO (see source semantics). |
| `trackingId` | `string` | yes | Consumer caller | Module lifecycle | Field `trackingId` on this DTO (see source semantics). |
| `matchCount` | `number` | no | Consumer caller | Module lifecycle | Field `matchCount` on this DTO (see source semantics). |
| `ambiguous` | `boolean` | no | Consumer caller | Module lifecycle | Field `ambiguous` on this DTO (see source semantics). |
| `providerDebugId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerDebugId` on this DTO (see source semantics). |

#### `ExecuteGetSellerMerchantStatusRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `providerMerchantId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerMerchantId` on this DTO (see source semantics). |

### `subscription.ts`

#### `SubscriptionProviderContext`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module persistence + reconciliation | Field `providerCode` on this DTO (see source semantics). |
| `accountRef` | `string` | yes | Consumer caller | Module lifecycle | Field `accountRef` on this DTO (see source semantics). |
| `applicationRef` | `string` | yes | Consumer caller | Module lifecycle | Field `applicationRef` on this DTO (see source semantics). |
| `environment` | `PaymentEnvironment` | yes | Consumer caller | Module lifecycle | Field `environment` on this DTO (see source semantics). |

#### `BillingCycleInput`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `tenureType` | `BillingTenureType` | yes | Consumer caller | Module lifecycle | Field `tenureType` on this DTO (see source semantics). |
| `sequence` | `number` | yes | Consumer caller | Module lifecycle | Field `sequence` on this DTO (see source semantics). |
| `totalCycles` | `number` | yes | Consumer caller | Module lifecycle | Field `totalCycles` on this DTO (see source semantics). |
| `intervalUnit` | `BillingIntervalUnit` | yes | Consumer caller | Module lifecycle | Field `intervalUnit` on this DTO (see source semantics). |
| `intervalCount` | `number` | yes | Consumer caller | Module lifecycle | Field `intervalCount` on this DTO (see source semantics). |
| `price` | `CanonicalMoney \| null` | no | Consumer caller | Module lifecycle | Field `price` on this DTO (see source semantics). |

#### `PaymentPreferencesInput`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `autoBillOutstanding` | `boolean` | no | Consumer caller | Module lifecycle | Field `autoBillOutstanding` on this DTO (see source semantics). |
| `setupFee` | `CanonicalMoney \| null` | no | Consumer caller | Module lifecycle | Field `setupFee` on this DTO (see source semantics). |
| `setupFeeFailureAction` | `'CONTINUE' \| 'CANCEL' \| null` | no | Consumer caller | Module lifecycle | Field `setupFeeFailureAction` on this DTO (see source semantics). |
| `paymentFailureThreshold` | `number \| null` | no | Consumer caller | Module lifecycle | Field `paymentFailureThreshold` on this DTO (see source semantics). |

#### `CreateCatalogProductRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `idempotencyKey` | `string` | yes | Consumer caller | Module store | Command deduplication key within idempotency scope. |
| `correlationId` | `string \| null` | no | Consumer caller | Module store | Optional consumer tracing reference stored on the operation. |
| `name` | `string` | yes | Consumer caller | Module lifecycle | Field `name` on this DTO (see source semantics). |
| `description` | `string \| null` | no | Consumer caller | Module lifecycle | Field `description` on this DTO (see source semantics). |
| `type` | `ProductType` | yes | Consumer caller | Module lifecycle | Field `type` on this DTO (see source semantics). |
| `category` | `string \| null` | no | Consumer caller | Module lifecycle | Field `category` on this DTO (see source semantics). |
| `homeUrl` | `string \| null` | no | Consumer caller | Module lifecycle | Field `homeUrl` on this DTO (see source semantics). |
| `imageUrl` | `string \| null` | no | Consumer caller | Module lifecycle | Field `imageUrl` on this DTO (see source semantics). |

#### `CatalogProductResult`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `productOperationId` | `string` | yes | Module lifecycle | Module lifecycle | Field `productOperationId` on this DTO (see source semantics). |
| `operationStatus` | `PaymentOperationStatus` | yes | Consumer caller | Module lifecycle | Field `operationStatus` on this DTO (see source semantics). |
| `productStatus` | `ProductStatus` | yes | Consumer caller | Module lifecycle | Field `productStatus` on this DTO (see source semantics). |
| `providerProductId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerProductId` on this DTO (see source semantics). |
| `name` | `string` | yes | Consumer caller | Module lifecycle | Field `name` on this DTO (see source semantics). |
| `type` | `ProductType` | yes | Consumer caller | Module lifecycle | Field `type` on this DTO (see source semantics). |
| `correlationId` | `string \| null` | yes | Consumer caller | Module store | Optional consumer tracing reference stored on the operation. |
| `providerDebugId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerDebugId` on this DTO (see source semantics). |

#### `GetCatalogProductRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `productOperationId` | `string` | yes | Module lifecycle | Module lifecycle | Field `productOperationId` on this DTO (see source semantics). |

#### `CreateBillingPlanRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `idempotencyKey` | `string` | yes | Consumer caller | Module store | Command deduplication key within idempotency scope. |
| `correlationId` | `string \| null` | no | Consumer caller | Module store | Optional consumer tracing reference stored on the operation. |
| `offeringRef` | `string \| null` | no | Consumer caller | Module lifecycle | Field `offeringRef` on this DTO (see source semantics). |
| `productOperationId` | `string` | yes | Module lifecycle | Module lifecycle | Field `productOperationId` on this DTO (see source semantics). |
| `name` | `string` | yes | Consumer caller | Module lifecycle | Field `name` on this DTO (see source semantics). |
| `description` | `string \| null` | no | Consumer caller | Module lifecycle | Field `description` on this DTO (see source semantics). |
| `status` | `'CREATED' \| 'ACTIVE'` | no | Consumer caller | Module lifecycle | Field `status` on this DTO (see source semantics). |
| `billingCycles` | `BillingCycleInput[]` | yes | Consumer caller | Module lifecycle | Field `billingCycles` on this DTO (see source semantics). |
| `paymentPreferences` | `PaymentPreferencesInput` | yes | Consumer caller | Module lifecycle | Field `paymentPreferences` on this DTO (see source semantics). |
| `returnUrl` | `string \| null` | no | Consumer caller | Module lifecycle | Field `returnUrl` on this DTO (see source semantics). |
| `cancelUrl` | `string \| null` | no | Consumer caller | Module lifecycle | Field `cancelUrl` on this DTO (see source semantics). |

#### `BillingPlanResult`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `planOperationId` | `string` | yes | Module lifecycle | Module lifecycle | Field `planOperationId` on this DTO (see source semantics). |
| `operationStatus` | `PaymentOperationStatus` | yes | Consumer caller | Module lifecycle | Field `operationStatus` on this DTO (see source semantics). |
| `planStatus` | `PlanStatus` | yes | Consumer caller | Module lifecycle | Field `planStatus` on this DTO (see source semantics). |
| `offeringRef` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `offeringRef` on this DTO (see source semantics). |
| `providerPlanId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerPlanId` on this DTO (see source semantics). |
| `providerProductId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerProductId` on this DTO (see source semantics). |
| `name` | `string` | yes | Consumer caller | Module lifecycle | Field `name` on this DTO (see source semantics). |
| `billingCycles` | `BillingCycleInput[]` | yes | Consumer caller | Module lifecycle | Field `billingCycles` on this DTO (see source semantics). |
| `correlationId` | `string \| null` | yes | Consumer caller | Module store | Optional consumer tracing reference stored on the operation. |
| `providerDebugId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerDebugId` on this DTO (see source semantics). |

#### `GetBillingPlanRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `planOperationId` | `string` | yes | Module lifecycle | Module lifecycle | Field `planOperationId` on this DTO (see source semantics). |

#### `PlanLifecycleRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `idempotencyKey` | `string` | yes | Consumer caller | Module store | Command deduplication key within idempotency scope. |
| `planOperationId` | `string` | yes | Module lifecycle | Module lifecycle | Field `planOperationId` on this DTO (see source semantics). |
| `correlationId` | `string \| null` | no | Consumer caller | Module store | Optional consumer tracing reference stored on the operation. |

#### `SubscriberInput`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `subscriberRef` | `string` | yes | Consumer caller | Module lifecycle | Field `subscriberRef` on this DTO (see source semantics). |
| `email` | `string \| null` | no | Consumer caller | Module lifecycle | Field `email` on this DTO (see source semantics). |

#### `SubscriptionPlanOperationReference`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `planOperationId` | `string` | yes | Module lifecycle | Module lifecycle | Field `planOperationId` on this DTO (see source semantics). |
| `providerPlanId` | `never` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerPlanId` on this DTO (see source semantics). |
| `offeringRef` | `never` | no | Consumer caller | Module lifecycle | Field `offeringRef` on this DTO (see source semantics). |

#### `SubscriptionProviderPlanReference`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerPlanId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerPlanId` on this DTO (see source semantics). |
| `offeringRef` | `string` | yes | Consumer caller | Module lifecycle | Field `offeringRef` on this DTO (see source semantics). |
| `planOperationId` | `never` | no | Module lifecycle | Module lifecycle | Field `planOperationId` on this DTO (see source semantics). |

#### `CreateSubscriptionRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `idempotencyKey` | `string` | yes | Consumer caller | Module store | Command deduplication key within idempotency scope. |
| `correlationId` | `string \| null` | no | Consumer caller | Module store | Optional consumer tracing reference stored on the operation. |
| `subscriber` | `SubscriberInput` | yes | Consumer caller | Module lifecycle | Field `subscriber` on this DTO (see source semantics). |
| `returnUrl` | `string \| null` | no | Consumer caller | Module lifecycle | Field `returnUrl` on this DTO (see source semantics). |
| `cancelUrl` | `string \| null` | no | Consumer caller | Module lifecycle | Field `cancelUrl` on this DTO (see source semantics). |

#### `SubscriptionResult`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `subscriptionOperationId` | `string` | yes | Module lifecycle | Module lifecycle | Field `subscriptionOperationId` on this DTO (see source semantics). |
| `operationStatus` | `PaymentOperationStatus` | yes | Consumer caller | Module lifecycle | Field `operationStatus` on this DTO (see source semantics). |
| `subscriptionStatus` | `SubscriptionStatus` | yes | Consumer caller | Module lifecycle | Field `subscriptionStatus` on this DTO (see source semantics). |
| `providerSubscriptionId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerSubscriptionId` on this DTO (see source semantics). |
| `providerPlanId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerPlanId` on this DTO (see source semantics). |
| `approvalUrl` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `approvalUrl` on this DTO (see source semantics). |
| `maskedSubscriber` | `string` | yes | Consumer caller | Module lifecycle | Field `maskedSubscriber` on this DTO (see source semantics). |
| `startTime` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `startTime` on this DTO (see source semantics). |
| `nextBillingTime` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `nextBillingTime` on this DTO (see source semantics). |
| `lifecycleReason` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `lifecycleReason` on this DTO (see source semantics). |
| `correlationId` | `string \| null` | yes | Consumer caller | Module store | Optional consumer tracing reference stored on the operation. |
| `providerDebugId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerDebugId` on this DTO (see source semantics). |
| `subscriptionStateRefreshPending` | `boolean` | no | Consumer caller | Module lifecycle | Field `subscriptionStateRefreshPending` on this DTO (see source semantics). |
| `subscriptionStateRefreshErrorCode` | `string \| null` | no | Consumer caller | Module lifecycle | Field `subscriptionStateRefreshErrorCode` on this DTO (see source semantics). |

#### `GetSubscriptionRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `subscriptionOperationId` | `string` | yes | Module lifecycle | Module lifecycle | Field `subscriptionOperationId` on this DTO (see source semantics). |

#### `RetrySubscriptionCreateRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `subscriptionOperationId` | `string` | yes | Module lifecycle | Module lifecycle | Field `subscriptionOperationId` on this DTO (see source semantics). |
| `subscriber` | `SubscriberInput` | yes | Consumer caller | Module lifecycle | Field `subscriber` on this DTO (see source semantics). |
| `returnUrl` | `string \| null` | no | Consumer caller | Module lifecycle | Field `returnUrl` on this DTO (see source semantics). |
| `cancelUrl` | `string \| null` | no | Consumer caller | Module lifecycle | Field `cancelUrl` on this DTO (see source semantics). |

#### `SubscriptionLifecycleCommandRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `idempotencyKey` | `string` | yes | Consumer caller | Module store | Command deduplication key within idempotency scope. |
| `subscriptionOperationId` | `string` | yes | Module lifecycle | Module lifecycle | Field `subscriptionOperationId` on this DTO (see source semantics). |
| `reason` | `string` | yes | Consumer caller | Module lifecycle | Field `reason` on this DTO (see source semantics). |
| `correlationId` | `string \| null` | no | Consumer caller | Module store | Optional consumer tracing reference stored on the operation. |

#### `ExecuteCreateCatalogProductRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `providerRequestId` | `string` | yes | Provider adapter / module | Provider port implementation | Module-generated idempotency token for a single provider HTTP attempt. |
| `name` | `string` | yes | Consumer caller | Module lifecycle | Field `name` on this DTO (see source semantics). |
| `description` | `string \| null` | no | Consumer caller | Module lifecycle | Field `description` on this DTO (see source semantics). |
| `type` | `ProductType` | yes | Consumer caller | Module lifecycle | Field `type` on this DTO (see source semantics). |
| `category` | `string \| null` | no | Consumer caller | Module lifecycle | Field `category` on this DTO (see source semantics). |
| `homeUrl` | `string \| null` | no | Consumer caller | Module lifecycle | Field `homeUrl` on this DTO (see source semantics). |
| `imageUrl` | `string \| null` | no | Consumer caller | Module lifecycle | Field `imageUrl` on this DTO (see source semantics). |

#### `ExecuteCreateCatalogProductResult`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerProductId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerProductId` on this DTO (see source semantics). |
| `productStatus` | `ProductStatus` | yes | Consumer caller | Module lifecycle | Field `productStatus` on this DTO (see source semantics). |
| `providerDebugId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerDebugId` on this DTO (see source semantics). |

#### `ExecuteGetCatalogProductRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `providerProductId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerProductId` on this DTO (see source semantics). |

#### `ExecuteGetCatalogProductResult`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerProductId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerProductId` on this DTO (see source semantics). |
| `name` | `string` | yes | Consumer caller | Module lifecycle | Field `name` on this DTO (see source semantics). |
| `type` | `ProductType` | yes | Consumer caller | Module lifecycle | Field `type` on this DTO (see source semantics). |
| `productStatus` | `ProductStatus` | yes | Consumer caller | Module lifecycle | Field `productStatus` on this DTO (see source semantics). |
| `providerDebugId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerDebugId` on this DTO (see source semantics). |

#### `ExecuteCreateBillingPlanRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `providerRequestId` | `string` | yes | Provider adapter / module | Provider port implementation | Module-generated idempotency token for a single provider HTTP attempt. |
| `providerProductId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerProductId` on this DTO (see source semantics). |
| `name` | `string` | yes | Consumer caller | Module lifecycle | Field `name` on this DTO (see source semantics). |
| `description` | `string \| null` | no | Consumer caller | Module lifecycle | Field `description` on this DTO (see source semantics). |
| `status` | `'CREATED' \| 'ACTIVE'` | no | Consumer caller | Module lifecycle | Field `status` on this DTO (see source semantics). |
| `billingCycles` | `BillingCycleInput[]` | yes | Consumer caller | Module lifecycle | Field `billingCycles` on this DTO (see source semantics). |
| `paymentPreferences` | `PaymentPreferencesInput` | yes | Consumer caller | Module lifecycle | Field `paymentPreferences` on this DTO (see source semantics). |
| `returnUrl` | `string \| null` | no | Consumer caller | Module lifecycle | Field `returnUrl` on this DTO (see source semantics). |
| `cancelUrl` | `string \| null` | no | Consumer caller | Module lifecycle | Field `cancelUrl` on this DTO (see source semantics). |

#### `ExecuteCreateBillingPlanResult`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerPlanId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerPlanId` on this DTO (see source semantics). |
| `providerProductId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerProductId` on this DTO (see source semantics). |
| `planStatus` | `PlanStatus` | yes | Consumer caller | Module lifecycle | Field `planStatus` on this DTO (see source semantics). |
| `providerDebugId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerDebugId` on this DTO (see source semantics). |

#### `ExecuteGetBillingPlanRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `providerPlanId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerPlanId` on this DTO (see source semantics). |

#### `ExecuteGetBillingPlanResult`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerPlanId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerPlanId` on this DTO (see source semantics). |
| `providerProductId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerProductId` on this DTO (see source semantics). |
| `planStatus` | `PlanStatus` | yes | Consumer caller | Module lifecycle | Field `planStatus` on this DTO (see source semantics). |
| `name` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `name` on this DTO (see source semantics). |
| `providerDebugId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerDebugId` on this DTO (see source semantics). |

#### `ExecutePlanLifecycleRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `providerPlanId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerPlanId` on this DTO (see source semantics). |

#### `ExecuteCreateSubscriptionRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `providerRequestId` | `string` | yes | Provider adapter / module | Provider port implementation | Module-generated idempotency token for a single provider HTTP attempt. |
| `providerPlanId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerPlanId` on this DTO (see source semantics). |
| `subscriberEmail` | `string \| null` | no | Consumer caller | Module lifecycle | Field `subscriberEmail` on this DTO (see source semantics). |
| `returnUrl` | `string \| null` | no | Consumer caller | Module lifecycle | Field `returnUrl` on this DTO (see source semantics). |
| `cancelUrl` | `string \| null` | no | Consumer caller | Module lifecycle | Field `cancelUrl` on this DTO (see source semantics). |

#### `ExecuteCreateSubscriptionResult`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerSubscriptionId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerSubscriptionId` on this DTO (see source semantics). |
| `providerPlanId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerPlanId` on this DTO (see source semantics). |
| `subscriptionStatus` | `SubscriptionStatus` | yes | Consumer caller | Module lifecycle | Field `subscriptionStatus` on this DTO (see source semantics). |
| `approvalUrl` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `approvalUrl` on this DTO (see source semantics). |
| `startTime` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `startTime` on this DTO (see source semantics). |
| `nextBillingTime` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `nextBillingTime` on this DTO (see source semantics). |
| `providerDebugId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerDebugId` on this DTO (see source semantics). |

#### `ExecuteGetSubscriptionRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `providerSubscriptionId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerSubscriptionId` on this DTO (see source semantics). |

#### `ExecuteGetSubscriptionResult`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerSubscriptionId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerSubscriptionId` on this DTO (see source semantics). |
| `providerPlanId` | `string \| null` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerPlanId` on this DTO (see source semantics). |
| `subscriptionStatus` | `SubscriptionStatus` | yes | Consumer caller | Module lifecycle | Field `subscriptionStatus` on this DTO (see source semantics). |
| `approvalUrl` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `approvalUrl` on this DTO (see source semantics). |
| `startTime` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `startTime` on this DTO (see source semantics). |
| `nextBillingTime` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `nextBillingTime` on this DTO (see source semantics). |
| `lifecycleReason` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `lifecycleReason` on this DTO (see source semantics). |
| `providerDebugId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerDebugId` on this DTO (see source semantics). |
| `providerSubscriptionStateAt` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerSubscriptionStateAt` on this DTO (see source semantics). |

#### `ExecuteSubscriptionLifecycleRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module + provider port | Provider identifier (for example paypal). |
| `accountRef` | `string` | yes | Consumer caller | Module store + provider port | Logical payment account scope. |
| `applicationRef` | `string` | yes | Consumer caller | Module store + provider port | Tenant application identifier (required on config). |
| `environment` | `sandbox \\| live` | yes | Consumer caller | Module + provider port | PayPal API environment target. |
| `providerSubscriptionId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerSubscriptionId` on this DTO (see source semantics). |
| `reason` | `string` | yes | Consumer caller | Module lifecycle | Field `reason` on this DTO (see source semantics). |

#### `ExecuteSubscriptionLifecycleRefreshPendingResult`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerSubscriptionId` | `string` | yes | Provider adapter / module | Module persistence + reconciliation | Field `providerSubscriptionId` on this DTO (see source semantics). |
| `subscriptionStateRefreshPending` | `true` | yes | Consumer caller | Module lifecycle | Field `subscriptionStateRefreshPending` on this DTO (see source semantics). |
| `subscriptionStateRefreshErrorCode` | `string \| null` | no | Consumer caller | Module lifecycle | Field `subscriptionStateRefreshErrorCode` on this DTO (see source semantics). |
| `lifecycleReason` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `lifecycleReason` on this DTO (see source semantics). |
| `providerDebugId` | `string \| null` | no | Provider adapter / module | Module persistence + reconciliation | Field `providerDebugId` on this DTO (see source semantics). |

#### `ExecuteSubscriptionLifecycleRefreshedResult`

Same fields as **`ExecuteGetSubscriptionResult`** (above), plus optional `subscriptionStateRefreshPending?: false` when refresh completed synchronously.

#### `ExecuteSubscriptionLifecycleResult`

Union: **`ExecuteSubscriptionLifecycleRefreshPendingResult`** \| **`ExecuteSubscriptionLifecycleRefreshedResult`**. Use `isExecuteSubscriptionLifecycleRefreshPending(result)` to discriminate.

### `webhook.ts`

#### `PaypalWebhookTransmissionHeaders`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `transmissionId` | `string` | yes | Consumer caller | Module lifecycle | Field `transmissionId` on this DTO (see source semantics). |
| `transmissionTime` | `string` | yes | Consumer caller | Module lifecycle | Field `transmissionTime` on this DTO (see source semantics). |
| `certUrl` | `string` | yes | Consumer caller | Module lifecycle | Field `certUrl` on this DTO (see source semantics). |
| `authAlgo` | `string` | yes | Consumer caller | Module lifecycle | Field `authAlgo` on this DTO (see source semantics). |
| `transmissionSig` | `string` | yes | Consumer caller | Module lifecycle | Field `transmissionSig` on this DTO (see source semantics). |

#### `VerifyWebhookRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer caller | Module persistence + reconciliation | Field `providerCode` on this DTO (see source semantics). |
| `accountRef` | `string` | yes | Consumer caller | Module lifecycle | Field `accountRef` on this DTO (see source semantics). |
| `environment` | `PaymentEnvironment` | yes | Consumer caller | Module lifecycle | Field `environment` on this DTO (see source semantics). |
| `webhookId` | `string` | yes | Consumer caller | Module lifecycle | Field `webhookId` on this DTO (see source semantics). |
| `rawBody` | `string` | yes | Consumer caller | Module lifecycle | Exact webhook body bytes/string for verification and replay. |
| `headers` | `PaypalWebhookTransmissionHeaders` | yes | Consumer caller | Module lifecycle | Field `headers` on this DTO (see source semantics). |

#### `VerifyWebhookResult`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `verified` | `boolean` | yes | Consumer caller | Module lifecycle | Field `verified` on this DTO (see source semantics). |
| `transmissionId` | `string` | yes | Consumer caller | Module lifecycle | Field `transmissionId` on this DTO (see source semantics). |
| `eventType` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `eventType` on this DTO (see source semantics). |
| `resourceId` | `string \| null` | yes | Consumer caller | Module lifecycle | Field `resourceId` on this DTO (see source semantics). |
| `unavailableReason` | `string` | no | Consumer caller | Module lifecycle | Field `unavailableReason` on this DTO (see source semantics). |
| `failureKind` | `VerifyWebhookFailureKind` | no | Consumer caller | Module lifecycle | Field `failureKind` on this DTO (see source semantics). |

#### `WebhookReceiptResponse`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `evidenceId` | `string` | yes | Consumer caller | Module lifecycle | Field `evidenceId` on this DTO (see source semantics). |
| `duplicate` | `boolean` | yes | Consumer caller | Module lifecycle | Field `duplicate` on this DTO (see source semantics). |
| `verificationStatus` | `EvidenceVerificationStatus` | yes | Consumer caller | Module lifecycle | Field `verificationStatus` on this DTO (see source semantics). |
| `processingStatus` | `EvidenceProcessingStatus` | yes | Consumer caller | Module lifecycle | Field `processingStatus` on this DTO (see source semantics). |

#### `ReconcilePaymentOperationsRequest`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `limit` | `number` | no | Consumer caller | Module lifecycle | Maximum rows or candidates processed in one batch. |
| `workerId` | `string` | no | Consumer caller | Module lifecycle | Recovery/reconciliation worker identity for claim leases. |

#### `CanonicalMoney`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `currency` | `string` | yes | Consumer caller | Module + provider port | ISO currency code. |
| `amountMinor` | `string` | yes | Consumer caller | Module + provider port | Integer amount in minor units encoded as a decimal string (not major units). |

#### `ReceiveWebhookInput`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `providerCode` | `string` | yes | Consumer HTTP handler | WebhookProcessingService | Provider routing scope. |
| `accountRef` | `string` | yes | Consumer HTTP handler | WebhookProcessingService | Account routing scope. |
| `applicationRef` | `string` | yes | Consumer HTTP handler | WebhookProcessingService | Application tenant scope. |
| `environment` | `sandbox \\| live` | yes | Consumer HTTP handler | WebhookProcessingService | Environment scope. |
| `rawBody` | `string` | yes | Consumer HTTP handler | WebhookProcessingService | Raw webhook body for verify + evidence insert. |
| `providerEventId` | `string` | yes | Consumer HTTP handler | WebhookProcessingService | Stable provider event id (PayPal transmission id). |
| `verify` | `() => Promise<VerifyWebhookResult>` | yes | Consumer HTTP handler | WebhookProcessingService | Verification callback (typically PaypalWebhookVerifier.verify). |

#### `VerifiedProcessedPaymentEvent`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `evidenceId` | `string` | yes | Module | PaymentEventConsumer | Evidence row primary key. |
| `providerCode` | `string` | yes | Module | PaymentEventConsumer | Scope field from evidence. |
| `accountRef` | `string` | yes | Module | PaymentEventConsumer | Scope field from evidence. |
| `applicationRef` | `string` | yes | Module | PaymentEventConsumer | Scope field from evidence. |
| `environment` | `sandbox \\| live` | yes | Module | PaymentEventConsumer | Scope field from evidence. |
| `eventType` | `string \| null` | yes | Module | PaymentEventConsumer | Provider event type after processing. |
| `resourceId` | `string \| null` | yes | Module | PaymentEventConsumer | Provider resource id from webhook. |
| `relatedOperationId` | `string \| null` | yes | Module | PaymentEventConsumer | Linked payment operation when correlated. |
| `processingStatus` | `EvidenceProcessingStatus` | yes | Module | PaymentEventConsumer | Processing dimension on evidence. |
| `verificationStatus` | `EvidenceVerificationStatus` | yes | Module | PaymentEventConsumer | Verification dimension on evidence. |

#### `NormalizedPaymentFailure`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `code` | `string` | yes | Module | Consumer RPC mapper | Stable reliability or capability code. |
| `category` | `PaymentFailureCategory` | yes | Module | Consumer RPC mapper | Failure category for UX/routing. |
| `causeCode` | `PaymentCauseCode \| string` | yes | Module | Consumer RPC mapper | Stable cause code from PAYMENT_CAUSE_CODE. |
| `nextAction` | `PaymentNextAction` | yes | Module | Consumer RPC mapper | Guidance only; not authorization to retry. |

#### `ClassifiedPaymentFailure`

| Field | Type | Required | Producer | Consumer | Meaning |
| --- | --- | ---: | --- | --- | --- |
| `code` | `string` | yes | Module | Server logs / toPublicFailure | Same as NormalizedPaymentFailure.code. |
| `category` | `PaymentFailureCategory` | yes | Module | Server logs / toPublicFailure | Same as NormalizedPaymentFailure.category. |
| `causeCode` | `PaymentCauseCode \| string` | yes | Module | Server logs / toPublicFailure | Same as NormalizedPaymentFailure.causeCode. |
| `nextAction` | `PaymentNextAction` | yes | Module | Server logs / toPublicFailure | Same as NormalizedPaymentFailure.nextAction. |
| `uncertain` | `boolean` | yes | Module | Server only | Whether provider outcome is uncertain. |
| `retryable` | `boolean` | yes | Module | Server only | Whether retry may be safe (still enforce idempotency). |
| `diagnosticMessage` | `string` | yes | Module | Server only | Sanitized diagnostic; not customer copy. |


---

## Advanced public helpers

| Helper | Purpose | Direct consumer use? |
| --- | --- | --- |
| `assertCapabilityReady(capabilities, capability)` | Throws `PaymentCapabilityError` if not ready | **Optional** before commands |
| `resolveProviderFailure(error)` | Maps unknown errors to sanitized `{ code, message, uncertain, retryable, providerDebugId }` | **Yes** for logging/metrics — not for UX copy |
| `isVerificationUnavailable(result)` | `VerifyWebhookResult` → boolean | **Yes** for HTTP 503 mapping |
| `verificationFailureKind(result)` | Normalizes failure kind | **Yes** when `failureKind` absent |
| `sha256Payload(raw: string)` | Evidence payload hash | **Store adapter** when inserting evidence |
| `missingStringFields` / `formatConfigurationIssue` | Config validation banners | **Composition root** only; not for runtime hot paths |

**Security:** `resolveProviderFailure` and reliability errors sanitize messages; helpers must not be used to reconstruct secrets from provider errors. `messageContainsSensitiveContent` / `sanitizePublicErrorMessage` (contracts) are for custom RPC mappers — normal consumers should rely on module-thrown errors.

**Stability:** `PAYMENT_CAUSE_CODE`, `PAYMENT_RELIABILITY_ERROR`, and port method shapes are semver-sensitive; PayPal HTTP client classes are implementation details even when exported.

---

## Public API inventory (integration-relevant)

Runtime values are exported from package entry points; types are compile-time only unless re-exported as values.

| Export | Entry | Kind | Purpose | Created by | Consumed by |
| --- | --- | --- | --- | --- | --- |
| `PaymentProviderConfig` | root | type | Explicit provider configuration | Consumer | `resolvePaymentRuntime`, factories |
| `resolvePaymentRuntime` | root | function | Resolve runtime + descriptor | Module | Consumer composition |
| `evaluateCapabilities` | root | function | Capability readiness rows | Module | Consumer / provider |
| `PaymentReliabilityStore` | root | interface | Persistence port | Consumer implements | All lifecycle + webhook + recovery |
| `MemoryPaymentReliabilityStore` | root | class | In-memory reference store (non-durable) | Module | **Tests and local dev only** — production must implement `PaymentReliabilityStore` |
| `PaymentEventConsumer` | root | interface | Business projection port | Consumer implements | Recovery (optional inline delivery) |
| `WebhookProcessingService` | root | class | Webhook inbox + evidence lifecycle | Consumer constructs | Consumer webhook handler |
| `PaymentRecoveryService` | root | class | Batch/single evidence recovery | Consumer constructs | Consumer scheduler/worker |
| `ReconciliationService` | root | class | Reconcile uncertain operations | Consumer constructs | Consumer worker |
| `CheckoutLifecycleService` | root | class | Checkout operation lifecycle | Consumer constructs | Consumer checkout commands |
| `PayoutLifecycleService` | root | class | Payout operation lifecycle | Consumer constructs | Consumer payout commands |
| `SubscriptionLifecycleService` | root | class | Subscription lifecycle | Consumer constructs | Consumer subscription commands |
| `MarketplaceLifecycleService` | root | class | Marketplace lifecycle | Consumer constructs | Consumer marketplace commands |
| `SellerOnboardingLifecycleService` | root | class | Seller referral lifecycle | Consumer constructs | Consumer seller commands |
| `ProviderEvidenceRecord` | root | type | Stored evidence row (+ `rawPayload`) | Store | Webhook, recovery, consumer |
| `PaymentOperation` | root | type | Stored operation row | Store | Lifecycle services |
| `PaymentReliabilityError` | root | class | Structured reliability failure | Module / store | Consumer error mapping |
| `PAYMENT_RELIABILITY_ERROR` | root | const | Stable error codes | Module | Consumer branching |
| `PaymentCapabilityError` | root | class | Capability unavailable | Module | Consumer error mapping |
| `VerifyWebhookRequest` / `VerifyWebhookResult` | root | types | Webhook verification contract | Consumer fills | `PaypalWebhookVerifier` |
| `WebhookReceiptResponse` | root | type | Webhook ingest result | Module | Consumer HTTP mapping |
| `RecoverPaymentReliabilityInput/Result` | root | types | Batch recovery | Consumer | `PaymentRecoveryService.recover` |
| `RecoverPaymentEvidenceInput/Result` | root | types | Single-evidence recovery | Consumer | `PaymentRecoveryService.recoverEvidence` |
| `ClaimPendingEvidenceInput` | root | type | Claim lease selection | Module | Store |
| `classifyWebhookEvidenceResume` | root | function | Duplicate/incomplete resume | Module | Webhook service |
| `isRecoverableEvidenceRow` | root | function | Recovery eligibility predicate | Module | Store claim |
| `toPaymentEvidenceAdminView` | root | function | Admin DTO mapping | Module | Consumer admin API |
| `createPaypalPaymentProvider` | paypal | function | PayPal provider facade | Module | Consumer |
| `buildPaypalWebhookVerifier` | paypal | function | Webhook verifier factory | Module | Consumer |
| `buildPaypalCheckoutExecutor` | paypal | function | Checkout executor factory | Module | Consumer |
| `buildPaypalPayoutExecutor` | paypal | function | Payout executor factory | Module | Consumer |
| `buildPaypalSubscriptionExecutor` | paypal | function | Subscription executor factory | Module | Consumer |
| `buildPaypalSellerOnboardingExecutor` | paypal | function | Seller onboarding factory | Module | Consumer |
| `buildPaypalMarketplaceExecutor` | paypal | function | Marketplace factory | Module | Consumer |
| `PaypalWebhookVerifier` | paypal | class | Signature verification | Module | Consumer verify callback |
| Checkout / payout / subscription / marketplace / seller **provider ports** | root | interfaces | Provider-neutral execution contracts | Consumer wires PayPal impl | Lifecycle services |

Internal-only symbols (for example concrete HTTP clients, retry policy constants not exported from barrels) are not public integration API.

---

## Store port contract (`PaymentReliabilityStore`)

Interface: `src/core/lib/persistence/payment-reliability-store.ts`.

### Operations (summary)

| Method | Input | Output | Module expectation | Consumer responsibility |
| --- | --- | --- | --- | --- |
| `createOperation` | `CreatePaymentOperationInput` | `PaymentOperation` | Idempotent on `(idempotencyScope, idempotencyKey)` | Enforce uniqueness; return existing or conflict |
| `findOperationById` | `operationId` | `PaymentOperation \| null` | Consistent read | Implement query |
| `findOperationByIdempotency` | scope, key | `PaymentOperation \| null` | Used for command idempotency | Unique index on scope+key |
| `findOperationByProvider*` (multiple) | provider ids | `PaymentOperation \| null` | Correlate webhooks/reconciliation | Indexes on provider reference fields |
| `claimOperationForExecution` | operation id, version | `PaymentOperation` | Optimistic concurrency | Atomic compare-and-set on `version` |
| `acquireCheckoutCreateExecutionLease` | operation id, version | lease result union | Checkout create retry safety | Atomic lease fields on operation |
| `updateOperation` / `transitionOperation` | update/transition input | `PaymentOperation` | Persist lifecycle transitions | Atomic updates; throw `PaymentReliabilityError` on conflict |
| `insertEvidence` | `InsertProviderEvidenceInput` | `ProviderEvidenceRecord` | Unique provider event per scope | **Unique** `(providerCode, accountRef, environment, providerEventId)` |
| `findEvidenceByProviderEvent` | provider event key | `ProviderEvidenceRecord \| null` | Duplicate webhook detection | Same uniqueness as insert |
| `updateEvidence` | `UpdateProviderEvidenceInput` | `ProviderEvidenceRecord` | Partial updates for lifecycle | Atomic row update |
| `claimPendingEvidence` | `ClaimPendingEvidenceInput` | `ProviderEvidenceRecord[]` | Recovery worker selection | Implement lease: exclusive until `claimLeaseExpiresAt`, same worker may renew |
| `listProviderEvidenceForRecovery` | list input | admin list result | Admin/recovery UI | Filter/paginate |
| Seller connection + marketplace unit methods | contract inputs | records | Seller/marketplace lifecycles | Consumer schema + uniqueness |

**`MemoryPaymentReliabilityStore`:** in-memory **reference / test adapter only** — not durable production persistence. Production consumers **must** implement `PaymentReliabilityStore` against their database. The memory store demonstrates claim/recovery semantics (`claimPendingEvidence` filters with `isRecoverableEvidenceRow`, sorts by `receivedAt`, sets `claimWorkerId` + `claimLeaseExpiresAt`); production stores must provide equivalent atomicity and uniqueness.

### Persistence guarantees the consumer must provide

- **Provider event uniqueness:** at most one evidence row per `(providerCode, accountRef, environment, providerEventId)`.
- **Evidence identity:** stable `evidenceId` primary key; updates via `updateEvidence`.
- **Operation idempotency:** unique `(idempotencyScope, idempotencyKey)` for command deduplication.
- **Claim/lease atomicity:** `claimPendingEvidence` must atomically assign lease fields so two workers cannot claim the same row concurrently.
- **Lease expiration:** expired leases (`claimLeaseExpiresAt <= now`) may be reclaimed by any worker; same worker may reclaim its own active lease (memory store allows this).
- **Recovery release:** `PaymentRecoveryService` clears `claimWorkerId` / `claimLeaseExpiresAt` in a `finally` block after each claimed row is processed.

The port does **not** mandate Supabase or PostgreSQL — any store with equivalent constraints and atomicity is valid.

### Evidence fields (persistence model)

See `ProviderEvidence` / `ProviderEvidenceRecord` in `src/contracts/lib/evidence.ts`. Notable fields:

| Field | Meaning |
| --- | --- |
| `verificationStatus` | `'pending' \| 'verified' \| 'rejected'` |
| `processingStatus` | `'pending' \| 'processed' \| 'unmatched' \| 'unsupported' \| 'failed'` |
| `consumerDeliveryStatus` | `'pending' \| 'confirmed' \| 'failed'` (optional on row) |
| `consumerDeliveryAttempts` | Delivery retry counter |
| `consumerDeliveryLastError` | **Sanitized** operator-safe message only |
| `claimWorkerId` / `claimLeaseExpiresAt` | Recovery lease |
| `rawPayload` | Server-side webhook body (not for browser) |

**Important:** when `consumerDeliveryStatus` is **undefined**, `isConsumerDeliveryComplete()` treats delivery as complete. Consumers using `PaymentEventConsumer` should set `consumerDeliveryStatus: 'pending'` when financial processing completes and business delivery is still required.

---

## `PaymentEventConsumer` contract

Interface: `src/core/lib/payment-event-consumer.ts`.

```typescript
export interface PaymentEventConsumer {
  deliver(event: VerifiedProcessedPaymentEvent): Promise<void>;
}
```

`VerifiedProcessedPaymentEvent` includes: `evidenceId`, `providerCode`, `accountRef`, `applicationRef`, `environment`, `eventType`, `resourceId`, `relatedOperationId`, `processingStatus`, `verificationStatus`.

| Aspect | Contract |
| --- | --- |
| When called | After evidence is `verificationStatus: 'verified'` and `processingStatus: 'processed'`, and delivery is not complete |
| Success | Resolve promise — module sets `consumerDeliveryStatus: 'confirmed'`, clears last error |
| Failure | Reject/throw — module sets `consumerDeliveryStatus: 'failed'`, increments attempts, persists **`consumerDeliveryLastError = 'Consumer event delivery failed'`** (raw consumer messages are **not** stored) |
| Idempotency | Consumer must tolerate redelivery of the same `evidenceId` without duplicating side effects |
| Business effects | **Consumer-owned:** subscription projection, order fulfillment, seller state, marketplace allocations, entitlements, notifications |

The module does **not** perform application-specific projections.

---

## Webhook contract

### Ingress API

`WebhookProcessingService.receiveWebhook(input: ReceiveWebhookInput)`:

| Field | Owner | Meaning |
| --- | --- | --- |
| `providerCode`, `accountRef`, `applicationRef`, `environment` | Consumer | Routing scope |
| `providerEventId` | Consumer | Stable provider event id (for example PayPal `transmissionId`) |
| `rawBody` | Consumer | Exact raw request body bytes/string |
| `verify` | Consumer | Async callback returning `VerifyWebhookResult` (typically `PaypalWebhookVerifier.verify`) |

Returns `WebhookReceiptResponse`: `{ evidenceId, duplicate, verificationStatus, processingStatus }`.

Also: `reprocessStoredWebhookEvidence(evidenceId)` for recovery/replay paths.

### Verification (`@idevconn/payment-providers/paypal`)

`VerifyWebhookRequest` includes PayPal transmission headers (`PaypalWebhookTransmissionHeaders`) and `webhookId`.

`VerifyWebhookResult.failureKind`:

| Value | Meaning | Typical consumer HTTP |
| --- | --- | --- |
| `signature_rejected` | Terminal bad signature / payload | 400 |
| `verification_unavailable` | Retryable provider/outage | 503 |
| `invalid_payload` | Terminal invalid JSON/body | 400 |

Duplicate / incomplete handling uses `classifyWebhookEvidenceResume` (`insert_new` | `resume` | `ack_duplicate` | `terminal_rejected`).

### Consumer responsibilities

- HTTP route, raw body capture (no premature JSON parse that alters bytes, if provider requires raw body)
- Provider headers forwarded into `VerifyWebhookRequest`
- Map module outcomes + verification unavailable to HTTP status
- Rate limits, authentication, and credential storage
- Wire `verify` using `buildPaypalWebhookVerifier` / `PaypalWebhookVerifier`

The module does **not** ship an HTTP controller.

---

## Recovery contract

### Methods

```typescript
class PaymentRecoveryService {
  recover(input: RecoverPaymentReliabilityInput): Promise<RecoverPaymentReliabilityResult>;
  recoverEvidence(input: RecoverPaymentEvidenceInput): Promise<RecoverPaymentEvidenceResult>;
}
```

### `RecoverPaymentReliabilityInput`

| Field | Default | Meaning |
| --- | --- | --- |
| `workerId` | required | Claim owner id |
| `limit` | `25` | Max rows claimed |
| `leaseMs` | `60000` | Claim lease duration |
| `environment`, `providerCode`, `accountRef` | optional | Claim filters |
| `evidenceIds` | optional | Restrict to specific ids |

### `RecoverPaymentReliabilityResult`

| Field | Meaning |
| --- | --- |
| `claimed` | Rows claimed this batch |
| `verified` | Reserved (not incremented by current implementation) |
| `processed` | Financial reprocess completed + delivery attempted in reprocess path |
| `delivered` | Delivery-only recovery succeeded |
| `skipped` | Row claimed but no action (includes pending verification skip) |
| `failed` | Thrown error during row processing (including consumer delivery failure) |

### Recovery behavior (canonical)

For each claimed row, `PaymentRecoveryService`:

1. **`verificationStatus === 'pending'`** → **`skipped`** (does **not** re-run verification). **KNOWN MODULE LIMITATION** — see below.
2. **`verified` + `processingStatus === 'pending'`** → reprocess webhook evidence; may call consumer → counts **`processed`** when processed.
3. **`verified` + `processed` + consumer not confirmed** → **`tryDeliverConsumer` only** (no financial reprocess) → **`delivered`** on success.
4. **`unmatched`** → reprocess path similar to pending processing.

After each row, claim lease fields are cleared so another worker can retry.

### Known module limitation (verification pending)

```text
Claimed evidence with verificationStatus === "pending" is not re-verified by
PaymentRecoveryService (row is skipped).
```

**Consumer responsibility:** retry webhook HTTP handling (same `providerEventId` resumes via duplicate/incomplete logic), or run a custom verification job that updates evidence through store methods — not via recovery skip path.

### Eligibility predicate

`isRecoverableEvidenceRow(evidence)` (exported) defines which rows `claimPendingEvidence` should select.

---

## Evidence lifecycle

### Status dimensions

| Dimension | Values |
| --- | --- |
| Verification | `pending` → `verified` \| `rejected` |
| Processing | `pending` → `processed` \| `unmatched` \| `unsupported` \| `failed` |
| Consumer delivery | optional: `pending` → `confirmed` \| `failed` |

### Compact transition table

| From | To | Driver | Recovery may act? | Consumer delivery? |
| --- | --- | --- | --- | --- |
| (new) | verification `pending` | `receiveWebhook` insert | yes (skipped until verified) | no |
| verification `pending` | `verified` / `rejected` | `verify()` callback result | pending rows skipped | no |
| verified + processing `pending` | `processed` / `unmatched` / … | Webhook processing / reprocess | yes | after `processed` |
| verified + `processed` | consumer `pending`/`failed` | Module sets when delivery required | yes (delivery-only) | yes |
| consumer `failed` | `confirmed` | Recovery retry success | yes | yes |
| consumer `confirmed` | — | Terminal for delivery | no (not recoverable for delivery) | no |

Resume actions for duplicate webhooks: see `classifyWebhookEvidenceResume`.

---

## Error contract

### Primary classes

| Error | Code field | Retryable? | Consumer action |
| --- | --- | --- | --- |
| `PaymentReliabilityError` | `code: PaymentReliabilityErrorCode` | depends on code | Map `code` to HTTP/RPC; retry only when code indicates retry |
| `PaymentCapabilityError` | `code = CAPABILITY_UNAVAILABLE` | no | Fix configuration or disable capability |
| `PaymentConfigurationError` | (core) | no | Fix explicit config |

### `PAYMENT_RELIABILITY_ERROR` codes (selection)

| Code | Meaning | Retryable | Consumer action |
| --- | --- | ---: | --- |
| `VERIFICATION_UNAVAILABLE` | Webhook verify outage | yes | Return 503; retry webhook |
| `VERIFICATION_REJECTED` | Bad signature | no | 400 / dead letter |
| `EVIDENCE_DUPLICATE` | Idempotent duplicate insert | no | Treat as ack |
| `PERSISTENCE_FAILURE` | Store/consumer delivery failure | often yes | Retry recovery; inspect store |
| `PROVIDER_RETRYABLE` / `PROVIDER_UNCERTAIN` | Provider HTTP ambiguity | yes | Retry command with idempotency |
| `PROVIDER_TERMINAL_REJECTION` / `PROVIDER_VALIDATION_REJECTION` | Terminal provider rejection | no | Fix request or mark failed |
| `INVALID_REQUEST` | Caller/store contract violation | no | Fix input |
| `TRANSITION_REJECTED` / `TRANSITION_CONFLICT` | Illegal state transition | no | Reconcile state |

Public `PaymentReliabilityError.message` values are **sanitized** (secrets/paths/tokens stripped). **Branch on `code` and structured fields**, not message text. `consumerDeliveryLastError` is always operator-safe (`Consumer event delivery failed` on delivery failures).

Helpers: `resolveProviderFailure`, `toPaymentReliabilityErrorPayload`, `rehydratePaymentCapabilityError` (RPC rehydration).

---

## Provider and PayPal models

### Provider-neutral layer

Lifecycle services depend on **provider ports** (for example `CheckoutProviderPort`, `PayoutProviderPort`, `SubscriptionProviderPort`, `SellerOnboardingProviderPort`, `MarketplaceProviderPort`) and `ReconciliationProviderLookup`. Consumer composition wires PayPal executors into these ports.

### PayPal subpath factories (pattern)

Each factory accepts:

- `runtime: ResolvedPaymentRuntime` (from `resolvePaymentRuntime`)
- `nodeEnv?: string`, `executionStatus?: PaymentExecutionStatus` (simulation / kill-switch)
- Factory-specific deps (for example checkout `strategyFactory`, seller `partnerConfig`)

When `shouldRejectProviderNetworkCalls` is true, factories return blocked/fake clients that fail closed without network.

| Factory | Returns | Notes |
| --- | --- | --- |
| `buildPaypalWebhookVerifier` | `PaypalWebhookVerifier` | Uses OAuth + live verification client when configured |
| `buildPaypalCheckoutExecutor` | `PaypalCheckoutExecutor` | Requires `PaymentStrategy` from `@idevconn/payment` |
| `buildPaypalPayoutExecutor` | `PaypalPayoutExecutor` | |
| `buildPaypalSubscriptionExecutor` | `PaypalSubscriptionExecutor` | Create retry policies exported |
| `buildPaypalSellerOnboardingExecutor` | `PaypalSellerOnboardingExecutor` | Requires explicit partner config at factory |
| `buildPaypalMarketplaceExecutor` | `PaypalMarketplaceExecutor` | Requires partner attribution |

Sandbox vs live endpoint selection follows `runtime.context.environment`.

---

## Domain boundaries (checkout, subscription, payout, marketplace, seller)

| Area | IMPLEMENTED BY MODULE | IMPLEMENTED THROUGH A PORT / MUST BE IMPLEMENTED BY CONSUMER | NOT IMPLEMENTED / OUT OF SCOPE |
| --- | --- | --- | --- |
| Checkout | Operation lifecycle, provider executor, webhook correlation | Store, consumer projection, product catalog/pricing | Full cart UX |
| Subscription | Lifecycle + provider executor + plan/binding helpers | Store, consumer entitlements, admin screens | Non-PayPal providers |
| Payout | Lifecycle + batch/item correlation | Store, consumer payout policy, KYC | — |
| Marketplace | Lifecycle + unit records + capture policy helpers | Store, revenue allocation, disputes | — |
| Seller onboarding | PayPal referral executor + seller connection records in store port | **Consumer** seller CRM, compliance UX, linking sellers to users | Module does **not** create application seller profiles by itself |
| Webhook inbox | `WebhookProcessingService` | HTTP ingress, verify wiring, credentials | HTTP controller in module |
| Recovery | `PaymentRecoveryService` | Scheduler/worker host, store claim impl | Re-verify `pending` rows |
| Admin reads | DTO helpers | Query API + DB views | Module admin HTTP |

Classifications used in reviews:

`IMPLEMENTED BY MODULE` · `IMPLEMENTED THROUGH A PORT` · `MUST BE IMPLEMENTED BY CONSUMER` · `INTENTIONALLY OUT OF SCOPE` · `KNOWN MODULE LIMITATION` · `NOT YET IMPLEMENTED`

---

## Consumer implementation checklist

1. **Load secrets** in server app (not in module) → build `PaymentProviderConfig`.
2. **Validate config** (`resolvePaymentRuntime`, capability rows).
3. **Implement `PaymentReliabilityStore`** with uniqueness + lease semantics.
4. **Implement `PaymentEventConsumer.deliver`** (idempotent projections).
5. **Create PayPal provider** (`createPaypalPaymentProvider`, executors via factories).
6. **Compose services** (`WebhookProcessingService`, lifecycle services, `PaymentRecoveryService`, optional `ReconciliationService`).
7. **Webhook transport** — raw body, headers, `verify` callback, HTTP status mapping.
8. **Map errors** via `PaymentReliabilityError.code` / `PaymentCapabilityError`.
9. **Run recovery** from cron/worker calling `recover` / `recoverEvidence`.
10. **Admin/query API** separate from command path (`listProviderEvidenceForRecovery`, custom SQL).
11. **Observability** — log/metric on codes, not raw messages.
12. **Test idempotency** — duplicate webhooks, duplicate delivery, concurrent claims.
13. **Test sandbox/live isolation** — separate credentials and store rows by `environment`.
14. **Test consumer delivery retries** — `consumerDeliveryStatus: 'pending'|'failed'` → recovery → `confirmed`.

---

## Minimal integration examples

### Store port skeleton (consumer-owned)

```typescript
import type {
  PaymentReliabilityStore,
  InsertProviderEvidenceInput,
  ProviderEvidenceRecord,
  ClaimPendingEvidenceInput,
} from '@idevconn/payment-providers';

export class PostgresPaymentReliabilityStore implements PaymentReliabilityStore {
  // Consumer implements all interface methods against its DB.
  async insertEvidence(input: InsertProviderEvidenceInput): Promise<ProviderEvidenceRecord> {
    // Enforce unique (providerCode, accountRef, environment, providerEventId).
    throw new Error('consumer placeholder');
  }
  async claimPendingEvidence(input: ClaimPendingEvidenceInput): Promise<ProviderEvidenceRecord[]> {
    // Atomic lease assignment + isRecoverableEvidenceRow filter equivalent.
    throw new Error('consumer placeholder');
  }
  // ... remaining methods ...
}
```

### PaymentEventConsumer skeleton

```typescript
import type { PaymentEventConsumer, VerifiedProcessedPaymentEvent } from '@idevconn/payment-providers';

export const consumer: PaymentEventConsumer = {
  async deliver(event: VerifiedProcessedPaymentEvent): Promise<void> {
    // Consumer-owned: update orders/subscriptions/sellers based on event.relatedOperationId
    if (!event.relatedOperationId) return;
  },
};
```

### Webhook processing

```typescript
import { WebhookProcessingService } from '@idevconn/payment-providers';
import { buildPaypalWebhookVerifier } from '@idevconn/payment-providers/paypal';

const webhookProcessing = new WebhookProcessingService(store);

export async function handlePaypalWebhook(rawBody: string, headers: PaypalWebhookTransmissionHeaders) {
  const verifier = buildPaypalWebhookVerifier({ runtime, nodeEnv: process.env.NODE_ENV });
  return webhookProcessing.receiveWebhook({
    providerCode: 'paypal',
    accountRef: 'default',
    applicationRef: 'my-app',
    environment: 'sandbox',
    providerEventId: headers.transmissionId,
    rawBody,
    verify: () =>
      verifier.verify({
        providerCode: 'paypal',
        accountRef: 'default',
        environment: 'sandbox',
        webhookId: config.credentials!.webhookId!,
        rawBody,
        headers,
      }),
  });
}
```

### Batch recovery

```typescript
import { PaymentRecoveryService } from '@idevconn/payment-providers';

const recovery = new PaymentRecoveryService({
  store,
  webhookProcessing,
  consumer,
});

const summary = await recovery.recover({
  workerId: 'worker-1',
  limit: 25,
  environment: 'sandbox',
});
```

### Single evidence recovery

```typescript
const result = await recovery.recoverEvidence({
  evidenceId: 'evidence-uuid',
  workerId: 'worker-1',
  environment: 'sandbox',
});
```

### Explicit runtime resolution (execution mode + PayPal)

```typescript
import {
  resolvePaymentRuntime,
  resolvePaymentExecutionMode,
  CheckoutLifecycleService,
  type PaymentProviderConfig,
} from '@idevconn/payment-providers';
import {
  buildNormalizedDeployedPaymentConfig,
  createPaypalPaymentProvider,
  buildPaypalCheckoutExecutor,
} from '@idevconn/payment-providers/paypal';

const normalized = buildNormalizedDeployedPaymentConfig({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  providerEnvironment: config.environment,
});
const executionStatus = resolvePaymentExecutionMode(normalized);
const runtime = resolvePaymentRuntime({ config, nodeEnv: normalized.nodeEnv, executionStatus });
const paypal = createPaypalPaymentProvider({ config, nodeEnv: normalized.nodeEnv, executionStatus });
const checkoutPort = buildPaypalCheckoutExecutor({
  runtime,
  strategyFactory: () => paypal.createCheckoutStrategy(),
  nodeEnv: normalized.nodeEnv,
  executionStatus,
});
const checkout = new CheckoutLifecycleService(store, checkoutPort);
```

### Checkout command with real DTO

```typescript
import { classifyPaymentFailure, toPublicFailure } from '@idevconn/payment-providers';

const result = await checkout.createCheckoutOrder({
  providerCode: 'paypal',
  accountRef: 'default',
  applicationRef: 'my-app',
  environment: 'sandbox',
  idempotencyKey: 'order-attempt-1',
  amount: { currency: 'USD', amountMinor: '1099' },
  returnUrl: 'https://example.com/return',
  cancelUrl: 'https://example.com/cancel',
});

if (result.outcome === 'failed') {
  const classified = classifyPaymentFailure({
    code: result.failure.code,
    causeCode: result.failure.causeCode,
  });
  const publicFailure = toPublicFailure(classified);
  // Branch on publicFailure.causeCode / nextAction — not message text.
}
```

### Partner mapping + seller onboarding executor

```typescript
import {
  buildPaypalSellerOnboardingExecutor,
  type PaypalSellerOnboardingPartnerConfig,
} from '@idevconn/payment-providers/paypal';

const partnerConfig: PaypalSellerOnboardingPartnerConfig = {
  partnerMerchantId: config.partner!.merchantId!,
  partnerAttributionId: config.partner!.attributionId!,
  returnUrl: config.partner!.sellerOnboardingReturnUrl!,
  products: config.partner!.sellerOnboardingProducts ?? [],
  features: config.partner!.sellerOnboardingFeatures ?? [],
};

const sellerPort = buildPaypalSellerOnboardingExecutor({
  runtime,
  partnerConfig,
  nodeEnv: normalized.nodeEnv,
  executionStatus,
});
```

### Reconciliation (actual `limit` signature)

```typescript
import { ReconciliationService } from '@idevconn/payment-providers';

const reconciliation = new ReconciliationService(store, reconciliationLookup);
const summary = await reconciliation.reconcile(50);
// ReconcilePaymentOperationsRequest.workerId is NOT consumed here.
```

### Seller connection store methods (consumer implements)

```typescript
import type {
  PaymentReliabilityStore,
  CreateSellerConnectionInput,
  SellerConnectionRecord,
} from '@idevconn/payment-providers';

async function ensureSellerConnection(
  store: PaymentReliabilityStore,
  input: CreateSellerConnectionInput,
): Promise<SellerConnectionRecord> {
  const existing = await store.findSellerConnectionBySellerRef(
    input.applicationRef,
    input.providerCode,
    input.accountRef,
    input.environment,
    input.sellerRef,
  );
  if (existing) return existing;
  return store.createSellerConnection(input);
}
```

---

## Public export coverage appendix

Maps every integration-relevant symbol reachable from the four source barrels (`src/index.ts`, `src/contracts/index.ts`, `src/core/index.ts`, `src/paypal/index.ts`). Classifications follow sections above; **NOT INTENDED FOR DIRECT CONSUMER USE** symbols remain public for tests and advanced composition only.

| Public export | Entry point | Documentation section | Classification |
| --- | --- | --- | --- |
| `AcquireCheckoutCreateExecutionLeaseResult` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `applyMarketplaceUnitSnapshots` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `applyPayoutTransition` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `ApplyPayoutTransitionInput` | @idevconn/payment-providers | Advanced helpers / module-internal composition | COMMAND/RESULT DTO |
| `ApplyPayoutTransitionResult` | @idevconn/payment-providers | Advanced helpers / module-internal composition | COMMAND/RESULT DTO |
| `applyPlanDomainUpdate` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `applyPlanTransition` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `ApplyPlanTransitionInput` | @idevconn/payment-providers | Advanced helpers / module-internal composition | COMMAND/RESULT DTO |
| `applySellerMerchantStatus` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `applySubscriptionDomainUpdate` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `applySubscriptionTransition` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `ApplySubscriptionTransitionInput` | @idevconn/payment-providers | Advanced helpers / module-internal composition | COMMAND/RESULT DTO |
| `assertCapabilityReady` | @idevconn/payment-providers | Lifecycle command DTOs or shared contracts | ADVANCED PUBLIC HELPER |
| `assertExecutionContextMatchesLocal` | @idevconn/payment-providers | Lifecycle command DTOs or shared contracts | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `assertPayoutFinancialTransitionAllowed` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `assertProviderNetworkPermitted` | @idevconn/payment-providers | Lifecycle command DTOs or shared contracts | NOT INTENDED FOR DIRECT CONSUMER USE |
| `assertSimulatedExecutionPermitted` | @idevconn/payment-providers | Lifecycle command DTOs or shared contracts | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `assertSubscriptionProviderPlanSnapshotConsistent` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `assertSubscriptionTransitionAllowed` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `assertTransitionAllowed` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `assertVerifiedEvidence` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `BillingCycleInput` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `BillingIntervalUnit` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `BillingPlanOperationBindingRequirements` | @idevconn/payment-providers | Lifecycle command DTOs or shared contracts | COMMAND/RESULT DTO |
| `BillingPlanResult` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `BillingTenureType` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `buildCommandFingerprint` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `buildNormalizedDeployedPaymentConfig` | @idevconn/payment-providers/paypal | Execution-mode API | PRIMARY CONSUMER API |
| `buildOperationIdempotencyScope` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `buildPaymentExecutionContext` | @idevconn/payment-providers | Execution-mode API | PRIMARY CONSUMER API |
| `buildPayoutTransitionProviderFields` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `buildPaypalCheckoutExecutor` | @idevconn/payment-providers/paypal | PayPal factory inputs | PRIMARY CONSUMER API |
| `BuildPaypalCheckoutExecutorInput` | @idevconn/payment-providers/paypal | PayPal factory inputs | COMMAND/RESULT DTO |
| `buildPaypalMarketplaceExecutor` | @idevconn/payment-providers/paypal | PayPal factory inputs | PRIMARY CONSUMER API |
| `BuildPaypalMarketplaceExecutorInput` | @idevconn/payment-providers/paypal | PayPal factory inputs | COMMAND/RESULT DTO |
| `buildPaypalPayoutExecutor` | @idevconn/payment-providers/paypal | PayPal factory inputs | PRIMARY CONSUMER API |
| `BuildPaypalPayoutExecutorInput` | @idevconn/payment-providers/paypal | PayPal factory inputs | COMMAND/RESULT DTO |
| `buildPaypalSellerOnboardingExecutor` | @idevconn/payment-providers/paypal | PayPal factory inputs | PRIMARY CONSUMER API |
| `BuildPaypalSellerOnboardingExecutorInput` | @idevconn/payment-providers/paypal | PayPal factory inputs | COMMAND/RESULT DTO |
| `buildPaypalSenderId` | @idevconn/payment-providers | Advanced helpers / module-internal composition | PRIMARY CONSUMER API |
| `buildPaypalSubscriptionExecutor` | @idevconn/payment-providers/paypal | PayPal factory inputs | PRIMARY CONSUMER API |
| `BuildPaypalSubscriptionExecutorInput` | @idevconn/payment-providers/paypal | PayPal factory inputs | COMMAND/RESULT DTO |
| `buildPaypalWebhookVerifier` | @idevconn/payment-providers/paypal | PayPal factory inputs | PRIMARY CONSUMER API |
| `BuildPaypalWebhookVerifierInput` | @idevconn/payment-providers/paypal | PayPal factory inputs | COMMAND/RESULT DTO |
| `buildProviderEventScope` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `CancelUnclaimedPayoutItemRequest` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `CancelUnclaimedPayoutItemResult` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `CanonicalMoney` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `canonicalMoneyToLegacyMajorAmount` | @idevconn/payment-providers | Lifecycle command DTOs | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `CAPABILITY_DEFINITIONS` | @idevconn/payment-providers | Lifecycle command DTOs or shared contracts | CONFIGURATION API or stable const |
| `CapabilityAvailability` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `CapabilityDefinition` | @idevconn/payment-providers | Lifecycle command DTOs or shared contracts | COMMAND/RESULT DTO |
| `CaptureCheckoutOrderRequest` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `CaptureMarketplaceOrderRequest` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `CaptureResult` | @idevconn/payment-providers | Lifecycle command DTOs | ADVANCED PUBLIC HELPER |
| `CatalogProductResult` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `CHECKOUT_CREATE_DEFAULT_REQUEST_TIMEOUT_MS` | @idevconn/payment-providers | Advanced helpers / module-internal composition | CONFIGURATION API or stable const |
| `CHECKOUT_CREATE_END_TO_END_HTTP_STEPS` | @idevconn/payment-providers | Advanced helpers / module-internal composition | CONFIGURATION API or stable const |
| `CHECKOUT_CREATE_EXECUTION_LEASE_MS` | @idevconn/payment-providers | Advanced helpers / module-internal composition | CONFIGURATION API or stable const |
| `CHECKOUT_CREATE_IN_FLIGHT_SAFETY_BUFFER_MS` | @idevconn/payment-providers | Advanced helpers / module-internal composition | CONFIGURATION API or stable const |
| `CheckoutCaptureResult` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `checkoutCreateExecutionLeaseExpiresAt` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `CheckoutCreateRetryOptions` | @idevconn/payment-providers | Store / Webhook / Recovery / Evidence | COMMAND/RESULT DTO |
| `CheckoutLifecycleService` | @idevconn/payment-providers | Store / Webhook / Recovery / Evidence | PRIMARY CONSUMER API |
| `CheckoutOperation` | @idevconn/payment-providers/paypal | PayPal factory inputs | COMMAND/RESULT DTO |
| `CheckoutOrderResult` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `CheckoutOrderStatus` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `CheckoutProviderContext` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `CheckoutProviderCreateExecutionClaimState` | @idevconn/payment-providers | Advanced helpers / module-internal composition | COMMAND/RESULT DTO |
| `CheckoutProviderCreateRetryEligibility` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `CheckoutProviderExecutionError` | @idevconn/payment-providers | Named provider ports | COMMAND/RESULT DTO |
| `CheckoutProviderPort` | @idevconn/payment-providers | Named provider ports | PROVIDER PORT |
| `ClaimPendingEvidenceInput` | @idevconn/payment-providers | Store / Webhook / Recovery / Evidence | COMMAND/RESULT DTO |
| `ClassifiedPaymentFailure` | @idevconn/payment-providers | Failure mapping | COMMAND/RESULT DTO |
| `classifyPaymentFailure` | @idevconn/payment-providers | Failure mapping | ADVANCED PUBLIC HELPER |
| `classifyPaypalMarketplaceCapture422` | @idevconn/payment-providers/paypal | PayPal factory inputs | COMMAND/RESULT DTO |
| `classifyWebhookEvidenceResume` | @idevconn/payment-providers | Advanced helpers / module-internal composition | ADVANCED PUBLIC HELPER |
| `ConsumerDeliveryStatus` | @idevconn/payment-providers | Store / Webhook / Recovery / Evidence | COMMAND/RESULT DTO |
| `correlatePayoutOperation` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `CreateBillingPlanRequest` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `createBlockedHttpClient` | @idevconn/payment-providers/paypal | PayPal factory inputs | COMMAND/RESULT DTO |
| `createBlockedOAuthClient` | @idevconn/payment-providers/paypal | PayPal factory inputs | COMMAND/RESULT DTO |
| `createBlockedWebhookVerificationClient` | @idevconn/payment-providers/paypal | PayPal factory inputs | COMMAND/RESULT DTO |
| `CreateCatalogProductRequest` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `CreateCheckoutOrderRequest` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `CreateMarketplaceOrderRequest` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `CreateOrderInput` | @idevconn/payment-providers | Lifecycle command DTOs | ADVANCED PUBLIC HELPER |
| `CreatePaymentOperationInput` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `createPaypalPaymentProvider` | @idevconn/payment-providers/paypal | PayPal factory inputs | PRIMARY CONSUMER API |
| `CreateSellerConnectionInput` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `CreateSellerReferralRequest` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `CreateSubscriptionRequest` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `currencyFractionDigits` | @idevconn/payment-providers | Lifecycle command DTOs | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `DEFAULT_MARKETPLACE_SELLER_READINESS_MAX_AGE_MS` | @idevconn/payment-providers | Advanced helpers / module-internal composition | CONFIGURATION API or stable const |
| `deriveBatchPayoutStatus` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `deriveMarketplaceOrderStatusFromUnits` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `deriveSellerConnectionStatus` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `ensureSellerReadyForMarketplace` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `evaluateCapabilities` | @idevconn/payment-providers | Runtime resolution and composition | PRIMARY CONSUMER API |
| `evaluateCheckoutCreateExecutionClaimState` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `evaluatePaypalCheckoutCreateExecutionClaimState` | @idevconn/payment-providers/paypal | PayPal factory inputs | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `evaluatePaypalCheckoutCreateRetryEligibility` | @idevconn/payment-providers/paypal | PayPal factory inputs | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `evaluatePaypalSubscriptionCreateRetryEligibility` | @idevconn/payment-providers/paypal | PayPal factory inputs | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `evaluateSellerConnectionReadiness` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `evaluateSubscriptionProviderStateOrdering` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `EvidenceProcessingStatus` | @idevconn/payment-providers | Store / Webhook / Recovery / Evidence | COMMAND/RESULT DTO |
| `EvidenceVerificationStatus` | @idevconn/payment-providers | Store / Webhook / Recovery / Evidence | COMMAND/RESULT DTO |
| `ExecuteCancelUnclaimedPayoutItemRequest` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `ExecuteCancelUnclaimedPayoutItemResult` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `ExecuteCaptureCheckoutOrderRequest` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `ExecuteCaptureCheckoutOrderResult` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `ExecuteCaptureMarketplaceOrderRequest` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `ExecuteCaptureMarketplaceOrderResult` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `ExecuteCreateBillingPlanRequest` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `ExecuteCreateBillingPlanResult` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `ExecuteCreateCatalogProductRequest` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `ExecuteCreateCatalogProductResult` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `ExecuteCreateCheckoutOrderRequest` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `ExecuteCreateCheckoutOrderResult` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `ExecuteCreateMarketplaceOrderRequest` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `ExecuteCreateMarketplaceOrderResult` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `ExecuteCreateSellerReferralRequest` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `ExecuteCreateSellerReferralResult` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `ExecuteCreateSubscriptionRequest` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `ExecuteCreateSubscriptionResult` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `ExecuteFindSellerMerchantRequest` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `ExecuteFindSellerMerchantResult` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `ExecuteGetBillingPlanRequest` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `ExecuteGetBillingPlanResult` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `ExecuteGetCatalogProductRequest` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `ExecuteGetCatalogProductResult` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `ExecuteGetCheckoutOrderRequest` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `ExecuteGetCheckoutOrderResult` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `ExecuteGetMarketplaceOrderRequest` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `ExecuteGetMarketplaceOrderResult` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `ExecuteGetPayoutBatchRequest` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `ExecuteGetPayoutBatchResult` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `ExecuteGetPayoutItemRequest` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `ExecuteGetPayoutItemResult` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `ExecuteGetRefundRequest` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `ExecuteGetRefundResult` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `ExecuteGetSellerMerchantStatusRequest` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `ExecuteGetSellerMerchantStatusResult` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `ExecuteGetSellerReferralRequest` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `ExecuteGetSellerReferralResult` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `ExecuteGetSubscriptionRequest` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `ExecuteGetSubscriptionResult` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `ExecuteMarketplaceUnit` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `ExecuteMarketplaceUnitSnapshot` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `ExecutePlanLifecycleRequest` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `ExecutePlanLifecycleResult` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `ExecuteRefundCaptureRequest` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `ExecuteRefundCaptureResult` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `ExecuteRefundMarketplaceUnitRequest` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `ExecuteRefundMarketplaceUnitResult` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `ExecuteSubmitPayoutBatchRequest` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `ExecuteSubmitPayoutBatchResult` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `ExecuteSubscriptionLifecycleRefreshedResult` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `ExecuteSubscriptionLifecycleRefreshPendingResult` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `ExecuteSubscriptionLifecycleRequest` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `ExecuteSubscriptionLifecycleResult` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `EXECUTION_MODE_BLOCKED` | @idevconn/payment-providers | Execution-mode API | CONFIGURATION API or stable const |
| `EXECUTION_MODE_MISMATCH` | @idevconn/payment-providers | Execution-mode API | CONFIGURATION API or stable const |
| `executionStatusDisplayLabel` | @idevconn/payment-providers | Execution-mode API | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `FakePaypalOrdersHttpClient` | @idevconn/payment-providers/paypal | PayPal implementation (see factories) | NOT INTENDED FOR DIRECT CONSUMER USE |
| `FakePaypalPayoutHttpClient` | @idevconn/payment-providers/paypal | PayPal implementation (see factories) | NOT INTENDED FOR DIRECT CONSUMER USE |
| `FakePaypalSellerOnboardingHttpClient` | @idevconn/payment-providers/paypal | PayPal implementation (see factories) | NOT INTENDED FOR DIRECT CONSUMER USE |
| `FakePaypalSubscriptionHttpClient` | @idevconn/payment-providers/paypal | PayPal implementation (see factories) | NOT INTENDED FOR DIRECT CONSUMER USE |
| `FakePaypalWebhookVerificationClient` | @idevconn/payment-providers/paypal | PayPal factory inputs | NOT INTENDED FOR DIRECT CONSUMER USE |
| `FetchPaypalOAuthHttpClient` | @idevconn/payment-providers/paypal | PayPal implementation (see factories) | NOT INTENDED FOR DIRECT CONSUMER USE |
| `FetchPaypalOrdersHttpClient` | @idevconn/payment-providers/paypal | PayPal implementation (see factories) | NOT INTENDED FOR DIRECT CONSUMER USE |
| `FetchPaypalPayoutHttpClient` | @idevconn/payment-providers/paypal | PayPal implementation (see factories) | NOT INTENDED FOR DIRECT CONSUMER USE |
| `FetchPaypalSellerOnboardingHttpClient` | @idevconn/payment-providers/paypal | PayPal implementation (see factories) | NOT INTENDED FOR DIRECT CONSUMER USE |
| `FetchPaypalSubscriptionHttpClient` | @idevconn/payment-providers/paypal | PayPal implementation (see factories) | NOT INTENDED FOR DIRECT CONSUMER USE |
| `findCapabilityAvailability` | @idevconn/payment-providers | Runtime resolution and composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `formatConfigurationIssue` | @idevconn/payment-providers | Failure mapping | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `formatSubscriptionProviderStateWatermark` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `FUNDING_SIMULATION_ENV` | @idevconn/payment-providers | Execution-mode API | CONFIGURATION API or stable const |
| `GatewayPaymentExecutionStatusResponse` | @idevconn/payment-providers | Execution-mode API | COMMAND/RESULT DTO |
| `GetBillingPlanRequest` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `GetBillingPlanResult` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `GetCatalogProductRequest` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `GetCatalogProductResult` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `GetCheckoutOrderRequest` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `GetMarketplaceOrderRequest` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `GetPayoutBatchRequest` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `GetPayoutBatchResult` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `GetPayoutItemRequest` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `GetPayoutItemResult` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `GetSellerConnectionRequest` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `GetSellerReferralRequest` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `GetSellerReferralResult` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `GetSubscriptionRequest` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `GetSubscriptionResult` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `InsertMarketplacePurchaseUnitInput` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `InsertProviderEvidenceInput` | @idevconn/payment-providers | Store / Webhook / Recovery / Evidence | COMMAND/RESULT DTO |
| `InsertReconciliationAttemptInput` | @idevconn/payment-providers | Store / Webhook / Recovery / Evidence | COMMAND/RESULT DTO |
| `invokeCheckoutWhenReady` | @idevconn/payment-providers/paypal | PayPal factory inputs | COMMAND/RESULT DTO |
| `isConsumerDeliveryComplete` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `isExecuteSubscriptionLifecycleRefreshPending` | @idevconn/payment-providers | Lifecycle command DTOs | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `isLegacySubscriptionProviderStateTransactionId` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `isLiveSafetyViolation` | @idevconn/payment-providers | Execution-mode API | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `isMarketplaceWebhookEvent` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `isPaymentCapabilityErrorPayload` | @idevconn/payment-providers | Failure mapping | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `isPayoutFinancialTransitionRejected` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `isPaypalWebhookEnvelopeId` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `isRecoverableEvidenceRow` | @idevconn/payment-providers | Advanced helpers / module-internal composition | ADVANCED PUBLIC HELPER |
| `isSellerOnboardingWebhookEvent` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `isSubscriptionPaymentEvidenceEvent` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `isSubscriptionProviderPlanMismatchError` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `isSubscriptionWebhookProviderRefreshEvent` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `isTerminalPreProviderFailureCode` | @idevconn/payment-providers | Failure mapping | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `isVerificationUnavailable` | @idevconn/payment-providers | Advanced helpers / module-internal composition | ADVANCED PUBLIC HELPER |
| `LegacyPaymentError` | @idevconn/payment-providers | Lifecycle command DTOs | ADVANCED PUBLIC HELPER |
| `ListPaymentEvidenceForRecoveryInput` | @idevconn/payment-providers | Store / Webhook / Recovery / Evidence | COMMAND/RESULT DTO |
| `ListPaymentEvidenceForRecoveryResult` | @idevconn/payment-providers | Store / Webhook / Recovery / Evidence | COMMAND/RESULT DTO |
| `LivePaypalWebhookVerificationClient` | @idevconn/payment-providers/paypal | PayPal factory inputs | NOT INTENDED FOR DIRECT CONSUMER USE |
| `majorUnitsToMinorString` | @idevconn/payment-providers | Lifecycle command DTOs | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `mapCheckoutWebhookEventToStatus` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `mapMarketplaceCaptureWebhookToUnitStatus` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `mapMerchantStatusToConnectionPatch` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `mapPayoutWebhookEventToFinancialStatus` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `mapPayoutWebhookEventToOperationKind` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `mapPaypalBatchStatus` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `mapPaypalItemTransactionStatus` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `mapPaypalOrderStatusToMarketplace` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `mapPaypalPlanStatus` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `mapPaypalProductStatus` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `mapPaypalSubscriptionStatus` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `mapPlanWebhookEventToStatus` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `mapSellerWebhookEventToConsentHint` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `mapSubscriptionWebhookEventToOperationKind` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `mapSubscriptionWebhookEventToStatus` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `mapWebhookEventToOperationKind` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `MARKETPLACE_SELLER_READINESS_MAX_AGE_MS` | @idevconn/payment-providers | Advanced helpers / module-internal composition | CONFIGURATION API or stable const |
| `MARKETPLACE_WEBHOOK_EVENTS` | @idevconn/payment-providers | Advanced helpers / module-internal composition | COMMAND/RESULT DTO |
| `MarketplaceLifecycleService` | @idevconn/payment-providers | Store / Webhook / Recovery / Evidence | PRIMARY CONSUMER API |
| `MarketplaceOrderResult` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `MarketplaceOrderStatus` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `MarketplaceProviderPort` | @idevconn/payment-providers | Named provider ports | PROVIDER PORT |
| `MarketplacePurchaseUnitRecord` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `MarketplaceSellerReadinessClock` | @idevconn/payment-providers | Advanced helpers / module-internal composition | COMMAND/RESULT DTO |
| `MarketplaceUnitInput` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `MarketplaceUnitResult` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `MarketplaceUnitStatus` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `maskRecipientValue` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `maskSubscriberEmail` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `maskSubscriberRef` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `MemoryPaymentReliabilityStore` | @idevconn/payment-providers | Store / Webhook / Recovery / Evidence | NOT INTENDED FOR DIRECT CONSUMER USE (in-memory reference / tests only) |
| `messageContainsSensitiveContent` | @idevconn/payment-providers | Failure mapping | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `minorUnitsToMajorString` | @idevconn/payment-providers | Lifecycle command DTOs | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `missingStringFields` | @idevconn/payment-providers | Failure mapping | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `MoneyValidationError` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `NormalizedDeployedPaymentConfig` | @idevconn/payment-providers | Execution-mode API | COMMAND/RESULT DTO |
| `NormalizedPaymentFailure` | @idevconn/payment-providers | Failure mapping | COMMAND/RESULT DTO |
| `normalizeExecutionRequest` | @idevconn/payment-providers | Advanced helpers / module-internal composition | ADVANCED PUBLIC HELPER |
| `OperationScopeInput` | @idevconn/payment-providers | Advanced helpers / module-internal composition | COMMAND/RESULT DTO |
| `OrderResult` | @idevconn/payment-providers | Lifecycle command DTOs | ADVANCED PUBLIC HELPER |
| `ParsedPaypalPayoutWebhook` | @idevconn/payment-providers | Advanced helpers / module-internal composition | COMMAND/RESULT DTO |
| `parseMarketplaceSellerReadinessMaxAgeMs` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `parsePaypalEnvironment` | @idevconn/payment-providers/paypal | Execution-mode API | PRIMARY CONSUMER API |
| `ParsePaypalEnvironmentResult` | @idevconn/payment-providers/paypal | Execution-mode API | COMMAND/RESULT DTO |
| `parsePaypalPayoutWebhookPayload` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `parsePurchaseUnitsFromOrderBody` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `parseSubscriptionResourceStateTimestamp` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `PAYMENT_CAPABILITIES` | @idevconn/payment-providers | Lifecycle command DTOs | CONFIGURATION API or stable const |
| `PAYMENT_CAPABILITY_UNAVAILABLE` | @idevconn/payment-providers | Failure mapping | CONFIGURATION API or stable const |
| `PAYMENT_CAUSE_CODE` | @idevconn/payment-providers | Failure mapping | CONFIGURATION API or stable const |
| `PAYMENT_DEPLOYMENT_ENVIRONMENT_ENV` | @idevconn/payment-providers | Execution-mode API | CONFIGURATION API or stable const |
| `PAYMENT_EXECUTION_MODE_ENV` | @idevconn/payment-providers | Execution-mode API | CONFIGURATION API or stable const |
| `PAYMENT_RELIABILITY_ERROR` | @idevconn/payment-providers | Failure mapping | CONFIGURATION API or stable const |
| `PAYMENT_RPC_TRANSITION_DETAIL` | @idevconn/payment-providers | Failure mapping | CONFIGURATION API or stable const |
| `PAYMENT_TRANSITION_REJECTION_REASON` | @idevconn/payment-providers | Failure mapping | CONFIGURATION API or stable const |
| `PaymentAccountContext` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `PaymentCapability` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `PaymentCapabilityError` | @idevconn/payment-providers | Failure mapping | COMMAND/RESULT DTO |
| `PaymentCapabilityErrorPayload` | @idevconn/payment-providers | Failure mapping | COMMAND/RESULT DTO |
| `PaymentCapabilityFlags` | @idevconn/payment-providers | Runtime resolution and composition | CONFIGURATION API |
| `PaymentCapabilityStatusSnapshot` | @idevconn/payment-providers | Execution-mode API | COMMAND/RESULT DTO |
| `PaymentCauseCode` | @idevconn/payment-providers | Failure mapping | COMMAND/RESULT DTO |
| `PaymentConfigurationError` | @idevconn/payment-providers | Failure mapping | COMMAND/RESULT DTO |
| `PaymentDeploymentEnvironment` | @idevconn/payment-providers | Execution-mode API | COMMAND/RESULT DTO |
| `PaymentEnvironment` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `PaymentError` | @idevconn/payment-providers | Lifecycle command DTOs | ADVANCED PUBLIC HELPER |
| `PaymentErrorCode` | @idevconn/payment-providers | Lifecycle command DTOs | ADVANCED PUBLIC HELPER |
| `PaymentEventConsumer` | @idevconn/payment-providers | Store / Webhook / Recovery / Evidence | PROVIDER PORT |
| `PaymentEvidenceAdminView` | @idevconn/payment-providers | Store / Webhook / Recovery / Evidence | COMMAND/RESULT DTO |
| `PaymentExecutionConfigAdapterInput` | @idevconn/payment-providers | Execution-mode API | COMMAND/RESULT DTO |
| `PaymentExecutionContext` | @idevconn/payment-providers | Execution-mode API | COMMAND/RESULT DTO |
| `PaymentExecutionIssue` | @idevconn/payment-providers | Execution-mode API | COMMAND/RESULT DTO |
| `PaymentExecutionIssueCode` | @idevconn/payment-providers | Execution-mode API | COMMAND/RESULT DTO |
| `PaymentExecutionMode` | @idevconn/payment-providers | Execution-mode API | COMMAND/RESULT DTO |
| `PaymentExecutionModeError` | @idevconn/payment-providers | Lifecycle command DTOs or shared contracts | COMMAND/RESULT DTO |
| `PaymentExecutionModeSource` | @idevconn/payment-providers | Execution-mode API | COMMAND/RESULT DTO |
| `PaymentExecutionPayload` | @idevconn/payment-providers | Execution-mode API | COMMAND/RESULT DTO |
| `PaymentExecutionRequest` | @idevconn/payment-providers | Execution-mode API | COMMAND/RESULT DTO |
| `PaymentExecutionStatus` | @idevconn/payment-providers | Execution-mode API | COMMAND/RESULT DTO |
| `PaymentExecutionStatusResponse` | @idevconn/payment-providers | Execution-mode API | COMMAND/RESULT DTO |
| `PaymentFailureCategory` | @idevconn/payment-providers | Failure mapping | COMMAND/RESULT DTO |
| `PaymentNextAction` | @idevconn/payment-providers | Failure mapping | COMMAND/RESULT DTO |
| `PaymentOperation` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `PaymentOperationKind` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `PaymentOperationStatus` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `PaymentOperationTransitionRecord` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `PaymentPartnerConfig` | @idevconn/payment-providers | Runtime resolution and composition | CONFIGURATION API |
| `PaymentPreferencesInput` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `PaymentProviderConfig` | @idevconn/payment-providers | Runtime resolution and composition | CONFIGURATION API |
| `PaymentProviderCredentials` | @idevconn/payment-providers | Runtime resolution and composition | CONFIGURATION API |
| `PaymentProviderDescriptor` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `PaymentRecoveryDependencies` | @idevconn/payment-providers | Store / Webhook / Recovery / Evidence | COMMAND/RESULT DTO |
| `PaymentRecoveryService` | @idevconn/payment-providers | Store / Webhook / Recovery / Evidence | PRIMARY CONSUMER API |
| `PaymentReliabilityError` | @idevconn/payment-providers | Failure mapping | COMMAND/RESULT DTO |
| `PaymentReliabilityErrorCode` | @idevconn/payment-providers | Failure mapping | COMMAND/RESULT DTO |
| `PaymentReliabilityErrorOptions` | @idevconn/payment-providers | Failure mapping | COMMAND/RESULT DTO |
| `PaymentReliabilityErrorPayload` | @idevconn/payment-providers | Failure mapping | COMMAND/RESULT DTO |
| `PaymentReliabilityErrorPaymentOutcome` | @idevconn/payment-providers | Failure mapping | COMMAND/RESULT DTO |
| `PaymentReliabilityStore` | @idevconn/payment-providers | Seller and marketplace store models | PROVIDER PORT |
| `PaymentResultOutcome` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `PaymentRuntimeMode` | @idevconn/payment-providers | Runtime resolution and composition | COMMAND/RESULT DTO |
| `PaymentRuntimeState` | @idevconn/payment-providers | Execution-mode API | COMMAND/RESULT DTO |
| `PaymentTransitionRejectionReason` | @idevconn/payment-providers | Failure mapping | COMMAND/RESULT DTO |
| `PayoutBatchItemResult` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `PayoutCorrelationResult` | @idevconn/payment-providers | Advanced helpers / module-internal composition | COMMAND/RESULT DTO |
| `PayoutEvidenceCorrelationContext` | @idevconn/payment-providers | Advanced helpers / module-internal composition | COMMAND/RESULT DTO |
| `PayoutFinancialStatus` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `payoutFinancialStatusToOperationStatus` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `PayoutLifecycleService` | @idevconn/payment-providers | Store / Webhook / Recovery / Evidence | PRIMARY CONSUMER API |
| `PayoutProviderContext` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `PayoutProviderExecutionError` | @idevconn/payment-providers | Named provider ports | COMMAND/RESULT DTO |
| `PayoutProviderPort` | @idevconn/payment-providers | Named provider ports | PROVIDER PORT |
| `PayoutRecipientInput` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `PayoutRecipientType` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `PayoutReconciliationProviderLookup` | @idevconn/payment-providers | Named provider ports | PROVIDER PORT |
| `PAYPAL_CHECKOUT_CREATE_END_TO_END_HTTP_STEPS` | @idevconn/payment-providers/paypal | PayPal factory inputs | COMMAND/RESULT DTO |
| `PAYPAL_CHECKOUT_CREATE_IDEMPOTENCY_WINDOW_MS` | @idevconn/payment-providers/paypal | PayPal factory inputs | COMMAND/RESULT DTO |
| `PAYPAL_CHECKOUT_CREATE_IN_FLIGHT_SAFETY_BUFFER_MS` | @idevconn/payment-providers/paypal | PayPal factory inputs | COMMAND/RESULT DTO |
| `PAYPAL_DEFAULT_CHECKOUT_REQUEST_TIMEOUT_MS` | @idevconn/payment-providers/paypal | PayPal factory inputs | COMMAND/RESULT DTO |
| `PAYPAL_MARKETPLACE_TERMINAL_PRE_CAPTURE_ISSUES` | @idevconn/payment-providers/paypal | PayPal factory inputs | COMMAND/RESULT DTO |
| `PAYPAL_MARKETPLACE_UNCERTAIN_CAPTURE_ISSUES` | @idevconn/payment-providers/paypal | PayPal factory inputs | COMMAND/RESULT DTO |
| `PAYPAL_SENDER_BATCH_ID_MAX` | @idevconn/payment-providers | Advanced helpers / module-internal composition | CONFIGURATION API or stable const |
| `PAYPAL_SENDER_ITEM_ID_MAX` | @idevconn/payment-providers | Advanced helpers / module-internal composition | CONFIGURATION API or stable const |
| `PAYPAL_SUBSCRIPTION_CREATE_IDEMPOTENCY_WINDOW_MS` | @idevconn/payment-providers/paypal | PayPal factory inputs | COMMAND/RESULT DTO |
| `PaypalCheckoutCreateExecutionClaimState` | @idevconn/payment-providers/paypal | PayPal factory inputs | COMMAND/RESULT DTO |
| `PaypalCheckoutCreateRetryEligibility` | @idevconn/payment-providers/paypal | PayPal factory inputs | COMMAND/RESULT DTO |
| `PaypalCheckoutExecutor` | @idevconn/payment-providers/paypal | PayPal implementation (see factories) | PRIMARY CONSUMER API |
| `PaypalCheckoutTokenProvider` | @idevconn/payment-providers/paypal | PayPal implementation (see factories) | COMMAND/RESULT DTO |
| `PaypalMarketplaceCapture422Classification` | @idevconn/payment-providers/paypal | PayPal factory inputs | COMMAND/RESULT DTO |
| `PaypalMarketplaceExecutor` | @idevconn/payment-providers/paypal | PayPal implementation (see factories) | PRIMARY CONSUMER API |
| `PaypalMarketplacePartnerConfig` | @idevconn/payment-providers/paypal | PayPal implementation (see factories) | COMMAND/RESULT DTO |
| `PaypalOAuthClient` | @idevconn/payment-providers/paypal | PayPal implementation (see factories) | NOT INTENDED FOR DIRECT CONSUMER USE |
| `PaypalOAuthCredentials` | @idevconn/payment-providers/paypal | PayPal implementation (see factories) | COMMAND/RESULT DTO |
| `PaypalOAuthHttpClient` | @idevconn/payment-providers/paypal | PayPal implementation (see factories) | COMMAND/RESULT DTO |
| `PaypalOrdersHttpClient` | @idevconn/payment-providers/paypal | PayPal implementation (see factories) | NOT INTENDED FOR DIRECT CONSUMER USE |
| `PaypalOrdersHttpRequest` | @idevconn/payment-providers/paypal | PayPal implementation (see factories) | COMMAND/RESULT DTO |
| `PaypalOrdersHttpResponse` | @idevconn/payment-providers/paypal | PayPal implementation (see factories) | COMMAND/RESULT DTO |
| `PaypalPaymentProvider` | @idevconn/payment-providers/paypal | PayPal factory inputs | COMMAND/RESULT DTO |
| `PaypalPayoutExecutor` | @idevconn/payment-providers/paypal | PayPal implementation (see factories) | PRIMARY CONSUMER API |
| `PaypalPayoutHttpClient` | @idevconn/payment-providers/paypal | PayPal implementation (see factories) | NOT INTENDED FOR DIRECT CONSUMER USE |
| `PaypalPayoutHttpRequest` | @idevconn/payment-providers/paypal | PayPal implementation (see factories) | COMMAND/RESULT DTO |
| `PaypalPayoutHttpResponse` | @idevconn/payment-providers/paypal | PayPal implementation (see factories) | COMMAND/RESULT DTO |
| `PaypalSellerOnboardingExecutor` | @idevconn/payment-providers/paypal | PayPal implementation (see factories) | PRIMARY CONSUMER API |
| `PaypalSellerOnboardingHttpClient` | @idevconn/payment-providers/paypal | PayPal implementation (see factories) | NOT INTENDED FOR DIRECT CONSUMER USE |
| `PaypalSellerOnboardingHttpRequest` | @idevconn/payment-providers/paypal | PayPal implementation (see factories) | COMMAND/RESULT DTO |
| `PaypalSellerOnboardingHttpResponse` | @idevconn/payment-providers/paypal | PayPal implementation (see factories) | COMMAND/RESULT DTO |
| `PaypalSellerOnboardingPartnerConfig` | @idevconn/payment-providers/paypal | PayPal implementation (see factories) | COMMAND/RESULT DTO |
| `PaypalSubscriptionCreateRetryEligibility` | @idevconn/payment-providers/paypal | PayPal factory inputs | COMMAND/RESULT DTO |
| `PaypalSubscriptionExecutor` | @idevconn/payment-providers/paypal | PayPal implementation (see factories) | PRIMARY CONSUMER API |
| `PaypalSubscriptionHttpClient` | @idevconn/payment-providers/paypal | PayPal implementation (see factories) | NOT INTENDED FOR DIRECT CONSUMER USE |
| `PaypalSubscriptionHttpRequest` | @idevconn/payment-providers/paypal | PayPal implementation (see factories) | COMMAND/RESULT DTO |
| `PaypalSubscriptionHttpResponse` | @idevconn/payment-providers/paypal | PayPal implementation (see factories) | COMMAND/RESULT DTO |
| `PaypalWebhookTransmissionHeaders` | @idevconn/payment-providers | Store / Webhook / Recovery / Evidence | COMMAND/RESULT DTO |
| `PaypalWebhookVerificationClient` | @idevconn/payment-providers/paypal | PayPal factory inputs | COMMAND/RESULT DTO |
| `PaypalWebhookVerifier` | @idevconn/payment-providers/paypal | PayPal factory inputs | PRIMARY CONSUMER API |
| `PERSISTED_PAYMENT_EXECUTION_MODES` | @idevconn/payment-providers | Execution-mode API | CONFIGURATION API or stable const |
| `PersistedPaymentExecutionMode` | @idevconn/payment-providers | Execution-mode API | COMMAND/RESULT DTO |
| `persistValidatedPayoutProviderIds` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `PersistValidatedPayoutProviderIdsInput` | @idevconn/payment-providers | Advanced helpers / module-internal composition | COMMAND/RESULT DTO |
| `PlanLifecycleRequest` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `PlanLifecycleResult` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `PlanStatus` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `planStatusToOperationStatus` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `ProductStatus` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `ProductType` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `ProviderEvidence` | @idevconn/payment-providers | Store / Webhook / Recovery / Evidence | COMMAND/RESULT DTO |
| `ProviderEvidenceKind` | @idevconn/payment-providers | Store / Webhook / Recovery / Evidence | COMMAND/RESULT DTO |
| `ProviderEvidenceRecord` | @idevconn/payment-providers | Store / Webhook / Recovery / Evidence | COMMAND/RESULT DTO |
| `readinessFromConnection` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `readSubscriptionProviderStateWatermark` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `ReceiveWebhookInput` | @idevconn/payment-providers | Store / Webhook / Recovery / Evidence | COMMAND/RESULT DTO |
| `ReconcilePaymentOperationsRequest` | @idevconn/payment-providers | Store / Webhook / Recovery / Evidence | COMMAND/RESULT DTO |
| `ReconcilePaymentOperationsResult` | @idevconn/payment-providers | Store / Webhook / Recovery / Evidence | COMMAND/RESULT DTO |
| `reconcileSellerConnectionAggregate` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `ReconcileSellerConnectionRequest` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `ReconcileSellerConnectionResult` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `ReconciliationAttempt` | @idevconn/payment-providers | Store / Webhook / Recovery / Evidence | COMMAND/RESULT DTO |
| `ReconciliationProviderLookup` | @idevconn/payment-providers | Named provider ports | PROVIDER PORT |
| `ReconciliationService` | @idevconn/payment-providers | Reconciliation API | PRIMARY CONSUMER API |
| `RecoverPaymentEvidenceInput` | @idevconn/payment-providers | Store / Webhook / Recovery / Evidence | COMMAND/RESULT DTO |
| `RecoverPaymentEvidenceResult` | @idevconn/payment-providers | Store / Webhook / Recovery / Evidence | COMMAND/RESULT DTO |
| `RecoverPaymentReliabilityInput` | @idevconn/payment-providers | Store / Webhook / Recovery / Evidence | COMMAND/RESULT DTO |
| `RecoverPaymentReliabilityResult` | @idevconn/payment-providers | Store / Webhook / Recovery / Evidence | COMMAND/RESULT DTO |
| `refreshPayoutBatchAggregate` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `RefundCaptureRequest` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `RefundCaptureResult` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `RefundMarketplaceUnitRequest` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `RefundMarketplaceUnitResult` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `RefundStatus` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `rehydratePaymentCapabilityError` | @idevconn/payment-providers | Failure mapping | COMMAND/RESULT DTO |
| `rehydratePaymentRpcError` | @idevconn/payment-providers | Failure mapping | ADVANCED PUBLIC HELPER |
| `RequestOptions` | @idevconn/payment-providers | Lifecycle command DTOs | ADVANCED PUBLIC HELPER |
| `resolveCheckoutCreateEndToEndRequestTimeoutMs` | @idevconn/payment-providers | Advanced helpers / module-internal composition | COMMAND/RESULT DTO |
| `ResolvedCheckoutCredentials` | @idevconn/payment-providers | Runtime resolution and composition | COMMAND/RESULT DTO |
| `ResolvedPaymentExecutionConfig` | @idevconn/payment-providers | Execution-mode API | COMMAND/RESULT DTO |
| `ResolvedPaymentRuntime` | @idevconn/payment-providers | Runtime resolution and composition | COMMAND/RESULT DTO |
| `ResolvedProviderFailure` | @idevconn/payment-providers | Failure mapping | COMMAND/RESULT DTO |
| `ResolveMarketplaceSellerReadinessMaxAgeInput` | @idevconn/payment-providers | Advanced helpers / module-internal composition | COMMAND/RESULT DTO |
| `resolveMarketplaceSellerReadinessMaxAgeMs` | @idevconn/payment-providers | Advanced helpers / module-internal composition | COMMAND/RESULT DTO |
| `resolveMarketplaceStatusFromOrder` | @idevconn/payment-providers | Advanced helpers / module-internal composition | COMMAND/RESULT DTO |
| `resolvePaymentExecutionConfig` | @idevconn/payment-providers | Execution-mode API | PRIMARY CONSUMER API |
| `resolvePaymentExecutionMode` | @idevconn/payment-providers | Execution-mode API | PRIMARY CONSUMER API |
| `resolvePaymentRuntime` | @idevconn/payment-providers | Runtime resolution and composition | PRIMARY CONSUMER API |
| `ResolvePaymentRuntimeInput` | @idevconn/payment-providers | Runtime resolution and composition | COMMAND/RESULT DTO |
| `resolvePaymentSubscriptionProviderContext` | @idevconn/payment-providers | Lifecycle command DTOs or shared contracts | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `resolvePaypalCheckoutCreateEndToEndRequestTimeoutMs` | @idevconn/payment-providers/paypal | PayPal factory inputs | COMMAND/RESULT DTO |
| `resolveProviderFailure` | @idevconn/payment-providers | Failure mapping | ADVANCED PUBLIC HELPER |
| `resolveProviderTransactionIdAfterSubscriptionStateWatermarkPersist` | @idevconn/payment-providers | Advanced helpers / module-internal composition | COMMAND/RESULT DTO |
| `resolveSubscriptionStatusTransition` | @idevconn/payment-providers | Advanced helpers / module-internal composition | COMMAND/RESULT DTO |
| `RetryCheckoutOrderRequest` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `RetrySubscriptionCreateRequest` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `sanitizeOperationalErrorMessage` | @idevconn/payment-providers | Failure mapping | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `sanitizePublicErrorMessage` | @idevconn/payment-providers | Failure mapping | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `ScopedTokenCacheRegistry` | @idevconn/payment-providers | Runtime resolution and composition | COMMAND/RESULT DTO |
| `SELLER_ONBOARDING_WEBHOOK_EVENTS` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `SellerConnectionReadiness` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `SellerConnectionReadinessChecks` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `SellerConnectionReconcileResult` | @idevconn/payment-providers | Advanced helpers / module-internal composition | COMMAND/RESULT DTO |
| `SellerConnectionReconciliationLookup` | @idevconn/payment-providers | Advanced helpers / module-internal composition | COMMAND/RESULT DTO |
| `SellerConnectionRecord` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `SellerConnectionResult` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `sellerConnectionResultFromRecord` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `SellerConnectionStatus` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `SellerConsentStatus` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `SellerOnboardingLifecycleService` | @idevconn/payment-providers | Store / Webhook / Recovery / Evidence | PRIMARY CONSUMER API |
| `SellerOnboardingProviderContext` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `SellerOnboardingProviderPort` | @idevconn/payment-providers | Named provider ports | PROVIDER PORT |
| `SellerOnboardingReconciliationProviderLookup` | @idevconn/payment-providers | Named provider ports | PROVIDER PORT |
| `SellerOnboardingWebhookEvent` | @idevconn/payment-providers | Advanced helpers / module-internal composition | COMMAND/RESULT DTO |
| `SellerReferralResult` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `sha256Payload` | @idevconn/payment-providers | Lifecycle command DTOs or shared contracts | ADVANCED PUBLIC HELPER |
| `shouldAbortPaymentStartup` | @idevconn/payment-providers | Execution-mode API | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `shouldBlockProviderNetwork` | @idevconn/payment-providers/paypal | PayPal factory inputs | COMMAND/RESULT DTO |
| `SubmitPayoutBatchItemInput` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `SubmitPayoutBatchRequest` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `SubmitPayoutBatchResult` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `SubscriberInput` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `SUBSCRIPTION_PROVIDER_STATE_WATERMARK_PREFIX` | @idevconn/payment-providers | Advanced helpers / module-internal composition | CONFIGURATION API or stable const |
| `subscriptionBillingFieldsFromProviderSnapshot` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `SubscriptionCreateRetryOptions` | @idevconn/payment-providers | Store / Webhook / Recovery / Evidence | COMMAND/RESULT DTO |
| `SubscriptionLifecycleCommandRequest` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `SubscriptionLifecycleCommandResult` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `SubscriptionLifecycleService` | @idevconn/payment-providers | Store / Webhook / Recovery / Evidence | PRIMARY CONSUMER API |
| `SubscriptionPlanOperationReference` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `SubscriptionProviderConfigReader` | @idevconn/payment-providers | Lifecycle command DTOs or shared contracts | COMMAND/RESULT DTO |
| `SubscriptionProviderContext` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `SubscriptionProviderCreateRetryEligibility` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `SubscriptionProviderPlanReference` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `SubscriptionProviderPlanSnapshot` | @idevconn/payment-providers | Advanced helpers / module-internal composition | COMMAND/RESULT DTO |
| `SubscriptionProviderPort` | @idevconn/payment-providers | Named provider ports | PROVIDER PORT |
| `SubscriptionProviderStateOrderingDecision` | @idevconn/payment-providers | Advanced helpers / module-internal composition | COMMAND/RESULT DTO |
| `SubscriptionReconciliationProviderLookup` | @idevconn/payment-providers | Named provider ports | PROVIDER PORT |
| `SubscriptionResult` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `SubscriptionStateApplySource` | @idevconn/payment-providers | Advanced helpers / module-internal composition | COMMAND/RESULT DTO |
| `SubscriptionStatus` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `subscriptionStatusToOperationStatus` | @idevconn/payment-providers | Advanced helpers / module-internal composition | COMMAND/RESULT DTO |
| `toCanonicalMoney` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `tokenCacheScope` | @idevconn/payment-providers | Runtime resolution and composition | COMMAND/RESULT DTO |
| `TokenCacheScopeInput` | @idevconn/payment-providers | Runtime resolution and composition | COMMAND/RESULT DTO |
| `toPaymentCapabilityErrorPayload` | @idevconn/payment-providers | Failure mapping | ADVANCED PUBLIC HELPER |
| `toPaymentEvidenceAdminView` | @idevconn/payment-providers | Lifecycle command DTOs or shared contracts | ADVANCED PUBLIC HELPER |
| `toPaymentReliabilityErrorPayload` | @idevconn/payment-providers | Failure mapping | ADVANCED PUBLIC HELPER |
| `toPublicFailure` | @idevconn/payment-providers | Failure mapping | ADVANCED PUBLIC HELPER |
| `TransitionPaymentOperationInput` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `UNCONFIGURED_FAKE_SIMULATION` | @idevconn/payment-providers | Lifecycle command DTOs | CONFIGURATION API or stable const |
| `UnconfiguredFakeCheckoutStrategy` | @idevconn/payment-providers/paypal | PayPal factory inputs | NOT INTENDED FOR DIRECT CONSUMER USE |
| `UnconfiguredFakeSimulation` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `UpdateMarketplacePurchaseUnitInput` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `UpdatePaymentOperationInput` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `UpdateProviderEvidenceInput` | @idevconn/payment-providers | Store / Webhook / Recovery / Evidence | COMMAND/RESULT DTO |
| `UpdateSellerConnectionInput` | @idevconn/payment-providers | Seller and marketplace store models | COMMAND/RESULT DTO |
| `validateBillingCycles` | @idevconn/payment-providers | Advanced helpers / module-internal composition | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `validateBillingPlanOperationBinding` | @idevconn/payment-providers | Lifecycle command DTOs or shared contracts | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `validateBillingPlanOperationForSubscriptionLifecycle` | @idevconn/payment-providers | Lifecycle command DTOs or shared contracts | MODULE-INTERNAL BEHAVIOR EXPOSED FOR COMPOSITION |
| `validateCanonicalMoney` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `validateOptionalRefundAmount` | @idevconn/payment-providers | Lifecycle command DTOs | COMMAND/RESULT DTO |
| `validatePayoutEvidenceMatch` | @idevconn/payment-providers | Advanced helpers / module-internal composition | COMMAND/RESULT DTO |
| `verificationFailureKind` | @idevconn/payment-providers | Advanced helpers / module-internal composition | ADVANCED PUBLIC HELPER |
| `VerifiedProcessedPaymentEvent` | @idevconn/payment-providers | Store / Webhook / Recovery / Evidence | COMMAND/RESULT DTO |
| `VerifyWebhookFailureKind` | @idevconn/payment-providers | Store / Webhook / Recovery / Evidence | COMMAND/RESULT DTO |
| `VerifyWebhookRequest` | @idevconn/payment-providers | Store / Webhook / Recovery / Evidence | COMMAND/RESULT DTO |
| `VerifyWebhookResult` | @idevconn/payment-providers | Store / Webhook / Recovery / Evidence | COMMAND/RESULT DTO |
| `WebhookEvidenceResumeAction` | @idevconn/payment-providers | Advanced helpers / module-internal composition | COMMAND/RESULT DTO |
| `WebhookProcessingService` | @idevconn/payment-providers | Store / Webhook / Recovery / Evidence | PRIMARY CONSUMER API |
| `WebhookReceiptResponse` | @idevconn/payment-providers | Store / Webhook / Recovery / Evidence | COMMAND/RESULT DTO |
| `WebhookSubscriptionProviderLookup` | @idevconn/payment-providers | Store / Webhook / Recovery / Evidence | PROVIDER PORT |
---

## Agent rules

Before reporting a missing feature, classify it:

1. Reusable module behavior (`IMPLEMENTED BY MODULE`)
2. Exported port (`IMPLEMENTED THROUGH A PORT`)
3. Consumer business logic (`MUST BE IMPLEMENTED BY CONSUMER`)
4. Consumer persistence/migrations
5. Consumer query/admin infrastructure
6. Provider/deployment configuration (explicit `PaymentProviderConfig`)
7. Documented limitation (`KNOWN MODULE LIMITATION`)
8. Genuinely missing module behavior (`NOT YET IMPLEMENTED`)

Agents working on this repository must **not**:

- Add application-specific business logic to the module
- Add NestJS, Supabase, or EDC domain dependencies to `src/`
- Add `.env` loading or EnvGetter-style configuration to the module
- Create parallel webhook/recovery lifecycle paths
- Treat seller/application projections as automatically module-owned
- Infer undocumented public APIs
- Persist or expose raw provider/consumer exception messages in operational fields
- Weaken idempotency, claim/lease, or evidence uniqueness semantics

Module-local verification (from package root, Node **>=22.12.0**):

```bash
npm run typecheck
npm run build
npm run test
npm run lint
npm pack --dry-run
```

Run **`build` before `test`** so dist declaration boundary tests reflect current exports.

---

## Relationship to EmployeeDrivenContent (EDC)

This package was adapted from reusable payment libraries; **EDC integration is a separate consumer task**. Do not assume EDC runtime when working in this repository.

---

## Accuracy notes / ambiguities

| Topic | Classification | Note |
| --- | --- | --- |
| Recovery `verified` counter | `KNOWN MODULE LIMITATION` | Not incremented by current `PaymentRecoveryService` implementation |
| Pending verification recovery | `KNOWN MODULE LIMITATION` | Rows skipped; consumer must re-drive verification |
| `consumerDeliveryStatus` undefined | Documented behavior | Treated as delivery-complete; set `pending` when using consumer delivery |
| Non-PayPal providers | `NOT YET IMPLEMENTED` | Capability/port shapes exist; only PayPal adapter ships here |
| HTTP admin APIs | `INTENTIONALLY OUT OF SCOPE` | Consumer implements |
| `ReconcilePaymentOperationsRequest.workerId` | `NOT USED BY CURRENT SERVICE` | Exported RPC DTO only; `ReconciliationService.reconcile(limit?)` ignores it |

---

## Inspection commands (read-only)

For agents validating this document against source, approved read-only commands:

```bash
cd /Users/kudenv/pr/www/idevcon/payment-providers-module
rg 'export ' src/index.ts src/core/index.ts src/contracts/index.ts src/paypal/index.ts
rg 'interface PaymentReliabilityStore|interface PaymentEventConsumer|PaymentProviderConfig' src
npm run build
rg 'EnvGetter|PAYMENT_MS_ENV_PATH' dist/*.d.ts || true
```

Do not modify production code when running documentation accuracy checks.
