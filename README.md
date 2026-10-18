# @idevconn/payment-providers

Provider-neutral payment contracts and orchestration, plus an optional PayPal adapter.

Extracted from [EmployeeDrivenContent](https://github.com/iDEVconn/EmployeeDrivenContent) (`libs/payment-contracts`, `libs/payment-core`, `libs/payment-provider-paypal`). The host application is **not** wired to this package yet.

## Entrypoints

- `@idevconn/payment-providers` — contracts and core (lifecycle services, ports, webhooks, reliability store interface, in-memory store for tests).
- `@idevconn/payment-providers/paypal` — PayPal HTTP executors, OAuth, webhook verification.

## Host responsibilities

Durable `PaymentReliabilityStore` implementations, NestJS transport (`payment-client` / payment microservice), and product ledger logic remain in the consuming application. Database schema `payment` and Supabase RPCs are **not** included in this package.

## Legacy checkout

Checkout still implements `@idevconn/payment` `PaymentStrategy` for order create/capture compatibility.

## Status

Initial extraction. Run `npm ci`, `npm run typecheck`, `npm run test`, and `npm run build` locally before publishing or integrating.
