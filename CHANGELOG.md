# @idevconn/payment-providers

## 0.2.1

### Patch Changes

- 70e6b6b: Rewrite the public README with standalone integration guidance, provider capability documentation, consumer-port responsibilities, configuration examples, webhook and recovery flows, and explicit package boundaries.

## 0.2.0

### Minor Changes

- 0fd4fd0: Standalone payment module release: extracted payment contracts, core execution engine, and PayPal provider adapter suitable for consumer apps without host monolith coupling.
  
  - Webhook incomplete-evidence resumption and payment recovery flows.
  - Claim/lease and idempotency behavior for safe retries.
  - `PaymentEventConsumer` with consumer-delivery acknowledgement and recovery semantics.
  - Explicit `PaymentProviderConfig` (required `applicationRef`); removal of environment getter and host `.env` coupling.
  - Sanitized provider- and consumer-facing error paths.
  - Standalone package test suite and architecture boundary checks on built `dist/`.
  - Expanded consumer integration contract documented in `AGENTS.md`.
