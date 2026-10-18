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

## Releasing

Payment Providers is published as **`@idevconn/payment-providers`** (public subpath **`@idevconn/payment-providers/paypal`**) from [iDEVconn/payment-providers](https://github.com/iDEVconn/payment-providers) on branch `main`.

1. Run `npx changeset` and select **`@idevconn/payment-providers`** with the appropriate semver bump.
2. Merge the changeset file to `main`. The **Release** workflow opens or updates a **Version Packages** pull request.
3. Merge the version PR. Release runs validation (`lint`, `typecheck`, `test`, `build`), publishes to npm with provenance, pushes the version tag, and creates a GitHub Release when one is missing.

**First publication:** `@idevconn/payment-providers@0.1.0` is already on the npm registry. Future releases require a changeset and version bump; a push with no pending changesets does not republish an existing version.

**External setup (not configured by workflow YAML):** GitHub Actions must allow the default token to create pull requests; npm scope access for `@idevconn`; and [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) for owner `iDEVconn`, repository `payment-providers`, workflow file `release.yml`.
