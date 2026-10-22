# T3 report: verifier, OAuth, HTTP, runtime (issues #7, #15, #16, #19, package side of #1)

Status: DONE_WITH_CONCERNS (concerns at the end; nothing blocks). Nothing committed, no git state changed.
Gate: `npm run lint && npm run typecheck && npm run build && npm test`: green, **91 files / 833 tests** (baseline 86 / 727).
Every new test was run first and seen failing (59 failures + the new OAuth file failing to import) before the fix.

## Files changed by T3 (diff -rq against .superpowers/snap-after-t2/)
New:
- src/paypal/lib/paypal-access-token-retry.ts
- src/paypal/lib/__tests__/paypal-oauth-token-retry.unit.test.ts
- src/paypal/lib/__tests__/paypal-webhook-verification-recovery.unit.test.ts
- src/paypal/lib/__tests__/live-paypal-http-clients.unit.test.ts
- src/paypal/lib/__tests__/paypal-factory-production-guard.unit.test.ts
- src/core/lib/__tests__/webhook-intake-guards.unit.test.ts

Edited:
- src/core/lib/token-cache-scope.ts, src/core/lib/resolve-payment-runtime.ts, src/core/lib/webhook-processing-service.ts
- src/paypal/index.ts, src/paypal/lib/paypal-oauth-client.ts, src/paypal/lib/live-paypal-http-clients.ts,
  src/paypal/lib/live-paypal-webhook-verification-client.ts, src/paypal/lib/paypal-webhook-verifier.ts,
  src/paypal/lib/paypal-webhook-verifier.factory.ts, src/paypal/lib/build-reject-only-executor.ts
- src/paypal/lib/paypal-{subscription,checkout,marketplace,payout,seller-onboarding}-executor.ts (T2 also edited these; only T3 hunks added, no reformatting)
- src/paypal/lib/paypal-{subscription,checkout,marketplace,payout,seller-onboarding}-executor.factory.ts
- tests: src/core/lib/__tests__/{resolve-payment-runtime,token-cache-scope}.unit.test.ts,
  src/paypal/lib/__tests__/{live-paypal-webhook-verification-client,paypal-checkout-executor.factory}.unit.test.ts

## What was done
1. OAuth (#16, #19). `tokenCacheScope` takes an optional `clientId` (key `account::env::clientId`; key without it unchanged). `PaypalOAuthClient.getAccessToken(scope, options?)` resolves credentials first and keys the cache by `clientId`; `options.rejectedToken` evicts the cached token only if it is still that token, so N concurrent 401s cause one refresh (joiners share the in-flight promise; late callers get the new token). One shared helper, `src/paypal/lib/paypal-access-token-retry.ts`: `resendWithFreshPaypalTokenOn401(tokenProvider, scope, token, send)` (executors) and `sendWithPaypalAccessToken(tokenProvider, scope, send)` (verify client). A 401 is resent once with a fresh token; a second 401 throws `{ code: PROVIDER_AUTH_FAILURE, retryable: false, uncertain: false, providerDebugId }` with a static message. Every PayPal call in the subscription, checkout, marketplace, payout and seller executors goes through a private `authorizedRequest` that uses it; the token is still fetched at the same statement position as before (keeps the kill-switch test order). `PaypalCheckoutTokenProvider` gained an optional second `options` parameter (additive); all six factories forward it.
2. Verifier (#19, #1). `LivePaypalWebhookVerificationClient`: any non-2xx after the token retry (400/401/403/404/409/422/5xx), a 2xx that is not JSON, or a 2xx without a string `verification_status` is `verification_unavailable`; a second 401 or an OAuth failure is also `verification_unavailable`. `PaypalWebhookVerifier`: `SUCCESS` verified, `FAILURE` `signature_rejected`, any other status `verification_unavailable`. Evidence therefore stays `pending/pending` and a redelivery processes it (p1 scenarios s401/s403/s400/200-without-status/503/html502/timeout ported). p8 ported: revoked cached token, 3 webhooks, 2 OAuth fetches, all processed.
3. #15. The verify client builds the outer JSON by hand: `JSON.stringify(fields)` minus `}` + `,"webhook_event":<raw>}`; raw must `JSON.parse` to an object (not array/null/scalar, no trailing text) or it is `invalid_payload` without a PayPal call. Test proves byte-for-byte with `é`/surrogate escapes, `1.10`, `1e2`, `-0.0`, key order. `PaypalWebhookVerificationClient` input gained optional `rawWebhookEvent`; the verifier passes `request.rawBody` and rejects non-object JSON as `invalid_payload`. Intake: `WebhookProcessingService` gained a third constructor param `WebhookIntakeOptions { maxBodyBytes = 262144, maxTransmissionSkewMs = 900000 (null disables), requireTransmissionHeaders = false, now }`; `ReceiveWebhookInput.providerEventId` is now optional and `headers?: PaypalWebhookTransmissionHeaders` was added. Before any store lookup, insert or verify call: missing/blank header (when headers are passed, or when required), non-string body, body over the cap in UTF-8 bytes, `transmissionTime` not fresh per `isFreshTransmission` (only when headers are passed), body id differing from the host id, or no id at all → `PaymentReliabilityError(INVALID_REQUEST)`; nothing is inserted (spy-asserted). The id defaults to `deriveProviderEventId(rawBody)`. Exported constants `DEFAULT_WEBHOOK_MAX_BODY_BYTES`, `DEFAULT_WEBHOOK_MAX_TRANSMISSION_SKEW_MS`.
4. #16 HTTP tests (stubbed `fetch`): `FetchPaypalSubscriptionHttpClient` and `FetchPaypalOAuthHttpClient` success (headers, request id, body), GET without body, 204 empty → `{}`, 4xx/5xx JSON with debug id, non-JSON → `raw` capped at 200 chars, real AbortController timeout → sanitized `PROVIDER_UNCERTAIN`, network error without token. Redirects: the code used the fetch default (`follow`). Now all five live clients and the verify client pass `redirect: 'error'`; tested that the option is sent and the refusal maps to a sanitized retryable error without the token or redirect target.
5. #7. `resolvePaymentRuntime` in production throws `PaymentConfigurationError` (message from `formatConfigurationIssue`, `missingFields` = setting names only) when: credentials are absent (lists the missing of `credentials.clientId`/`credentials.clientSecret`, plus `executionStatus` when it is also missing, even with checkout disabled), `executionStatus` is unconfigured / simulation / provider calls off (`executionStatus.runtimeState`, `executionStatus.providerCallsEnabled`, issue codes), or forbidden/conflict (was plain `Error`, now the typed subclass, same message). Factories: new `assertProviderNetworkAllowedInProduction` (build-reject-only-executor.ts) is called first in all six factories and throws in production whenever the factory would build a blocked client. `buildPaypalWebhookVerifier` gained `webhookId` and `requireWebhookId` (default `nodeEnv === 'production'`); a missing/blank id throws `PaymentConfigurationError(['webhookId'])` at build; the id is passed to the verifier (new optional 4th constructor arg `{ webhookId }`) and used when a request has none. Non-production behaviour is unchanged (tested for `undefined`, `development`, `test`, `prod`).

## Tests changed because they encoded a defect
- live-paypal-webhook-verification-client: "non-retryable HTTP status (401) as invalid_payload" → now `verification_unavailable`; "malformed JSON verify responses" → now `verification_unavailable`.
- resolve-payment-runtime: "starts in production with missing credentials using reject mode" → now throws `PaymentConfigurationError`.
- paypal-checkout-executor.factory: "builds a reject-mode executor in production when credentials are missing" → now throws; the reject-mode build is kept as a development test.

## Rulings
- Ruling: headers are optional on `ReceiveWebhookInput` (dozens of existing callers pass none). They are fully checked whenever passed; `requireTransmissionHeaders: true` makes them mandatory. Default false so existing hosts keep working; README (T7) should tell hosts to pass headers and set it.
- Ruling: a host id with a body that has no `id` is still accepted (many existing tests and non-PayPal-shaped bodies); a body id that differs from the host id is rejected; no id anywhere is rejected.
- Ruling: intake rejections use the existing `INVALID_REQUEST` code (no new code in the union, so exhaustive host switches keep compiling); messages name fields, never values.
- Ruling: factories throw in production for any reject-only composition (fake runtime, missing credentials, or a blocking `executionStatus`), not only for missing credentials, since that is what "the runtime would be fake" means at the factory.
- Ruling: request `webhookId` wins over the build-time one when non-blank (backwards compatible); the build-time id is the fallback.
- Ruling: the second 401 in the verify path is `verification_unavailable` (spec item 2), while executors get `PROVIDER_AUTH_FAILURE` (spec item 1).
- Ruling: `redirect: 'error'` (fail closed) rather than `manual`, because executors treat <400 as success and a 3xx would be misread.

## Security checks done
- Tokens/secrets: helper and client errors use static messages; tests assert no token, Basic credential, client secret or redirect target in thrown errors or `JSON.stringify(error)`.
- Raw splice: the raw text must parse as a single JSON object (`JSON.parse` rejects trailing text), so it cannot close the object early or inject/override outer keys (tested with `{"a":1}}, "webhook_id":"x"` and `{"a":1} {"b":2}`).
- Intake runs before DB lookup, insert and the verify call; size is checked before any JSON parse; `length > cap` short-circuits before UTF-8 encoding of huge bodies.
- Single flight: compare-and-evict keyed by the rejected token; 10 concurrent 401s → 1 refresh (tested).
- Production config errors list setting names only (tested that client id/secret values do not appear).

## Concerns
1. Freshness default (15 min) is applied to redeliveries too. If PayPal resends a failed delivery with its original `PAYPAL-TRANSMISSION-TIME`, retries older than 15 minutes would be rejected at intake. I could not confirm PayPal's behaviour without network; hosts can set `maxTransmissionSkewMs: null` or a larger window. Worth checking against a real sandbox redelivery before release.
2. Rows already stored as `rejected/VERIFICATION_REJECTED` by older versions because of a verify 401/403/400 stay terminal (`webhook-evidence-resume.ts`); making them re-verifiable needs a stored marker, not message matching. Not done.
3. README examples (`buildPaypalWebhookVerifier({ runtime, nodeEnv })`) now throw in production without `webhookId`; T7 must update them and document `WebhookIntakeOptions`, `headers`, optional `providerEventId`, `requireWebhookId`.
4. Each factory call still creates its own `PaypalOAuthClient` (issue #16 bullet 3), and the OAuth base URL still comes from `credentials.environment`; out of this task's list.
5. "Byte-for-byte" holds for the JS string the host passes; a host that decodes the request with a non-UTF-8 charset or re-serialises it before calling us still breaks verification.
6. `tsc -p tsconfig.test.json` has 6 pre-existing errors in test/public-exports.unit.test.ts (not from T3); new test files type-check.

## Commit message
```
fix(paypal): token retry on 401, raw-body verify, intake guards, prod boot checks

- OAuth cache keyed by clientId; a 401 evicts the token and resends once with
  a fresh one (single flight); a second 401 is PROVIDER_AUTH_FAILURE. One
  shared helper for all five executors and the webhook verify client.
- verify-webhook-signature: any non-2xx after the retry, or a 2xx without
  verification_status, is verification_unavailable; only FAILURE rejects.
- Send PayPal the original raw event text (hand-built outer JSON).
- Webhook intake rejects missing headers, bodies over maxBodyBytes (256 KiB),
  stale transmissionTime (15 min) and event-id mismatches before inserting
  evidence; providerEventId defaults to the body id.
- Live HTTP clients refuse redirects; tests for the subscription and OAuth
  fetch clients.
- Production: resolvePaymentRuntime and the factories throw
  PaymentConfigurationError instead of booting reject-only; the verifier
  factory checks webhookId at build (requireWebhookId).

Refs #7, #15, #16, #19, #1

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
```

## Fix wave (review .superpowers/t3-review.md, items 1-5)

Gate: `npm run lint && npm run typecheck && npm run build && npm test` green, **91 files / 857 tests** (before the wave: 833). New tests were run first: 17 failed; the 2 PayPal-Request-Id tests passed immediately because they pin behaviour that was already correct (item 5 asked for exactly that pin).

1. Freshness is opt-in, asymmetric and only applies to new events. `WebhookIntakeOptions` now has `maxTransmissionAgeMs` (default `null` = off; the doc comment recommends at least 72 h = 259200000 because PayPal retries for about 3 days) and `maxTransmissionFutureMs` (default `DEFAULT_WEBHOOK_MAX_TRANSMISSION_FUTURE_MS` = 300000, used only when the age check is on). `maxTransmissionSkewMs` is `@deprecated`: it sets both directions unless they are given explicitly, and `null` keeps the check off. The check now runs in `receiveWebhook` after `findEvidenceByProviderEvent` and before the insert (`assertFreshTransmission`), so a stored event always resumes. The reviewer's probe is ported as a test: verify is unavailable, the evidence is stored pending, PayPal redelivers 20 minutes later with the original transmission time while a 15-minute age window is set, and the event gets verified. `DEFAULT_WEBHOOK_MAX_TRANSMISSION_SKEW_MS` stays exported but is no longer used as a default. The old "15 min default" tests were replaced with: off by default, age and future limits, future option alone ignored, alias, and the redelivery test.
2. Production escape hatches.
   (a) Kill switch. New exported `isProviderCallsKillSwitch(status)`: `runtimeState: 'configured'`, mode not `simulation`, `providerCallsEnabled: false`. In production, `resolvePaymentRuntime` returns the reject-only runtime for it and does not throw. `buildPaypalWebhookVerifier` allows it (`allowKillSwitch: true` passed to the shared assert), builds the blocked client, and `verify` returns `verification_unavailable`. Tested end to end: the resolved production runtime with the kill switch, then the verifier, then `receiveWebhook` stores the evidence as `pending/pending`. Intake never looks at the runtime. The five executor factories still throw on the kill switch unless they get the opt-in (tested).
   (b) New `allowRejectOnlyInProduction?: boolean` on `ResolvePaymentRuntimeInput` and on all six factory inputs. With it, production keeps the pre-T3 reject-only behaviour (fake runtime plus banner, blocked clients). Without it, production still throws for fake, unconfigured or simulated execution and for missing credentials. Forbidden/conflict still throw even with the opt-in (tested). The behaviour is documented in comments on the input field, on `isProviderCallsKillSwitch` and on `assertProviderNetworkAllowedInProduction`.
   The webhook id is now required by default only when `nodeEnv === 'production'` AND the verifier would actually call PayPal. A kill-switch or reject-only verifier never reaches PayPal, so it builds without one. An explicit `requireWebhookId` still wins.
3. Outer verify body: when every outer field is undefined, the envelope `{}` is followed by no comma, giving `{"webhook_event":...}`. Tested: the result is valid JSON.
4. Intake options are validated in the constructor (`resolveTransmissionWindow`). `maxBodyBytes` must be a finite integer > 0. `maxTransmissionAgeMs`, `maxTransmissionSkewMs` and `maxTransmissionFutureMs` must be finite numbers > 0; only age and skew may be `null`. NaN, 0, negative and Infinity values throw `PaymentConfigurationError([key])`. Tested.
5. New tests assert that both requests of subscription `createSubscription` and of checkout `captureOrder` (the revoked token, then the fresh one) carry the same `requestId`.

Rulings (fix wave)
- Ruling: the kill switch is exempt only for `resolvePaymentRuntime` (the verifier needs a runtime) and the verifier factory. Executor factories still need `allowRejectOnlyInProduction`, since the owner decision names only the verifier and intake.
- Ruling: simulation mode in production still throws. It sets `providerCallsEnabled: false` but is a mode, not a kill switch.
- Ruling: `maxTransmissionFutureMs` cannot be `null` (its type is a number). Turning it off would allow any future time; set a large value instead.
- Ruling: the default for `requireWebhookId` follows whether the verifier would call PayPal (see item 2).

Files changed in this wave (all already in the T3 list; no new files):
src/core/lib/webhook-processing-service.ts, src/core/lib/resolve-payment-runtime.ts, src/paypal/lib/build-reject-only-executor.ts, src/paypal/lib/live-paypal-webhook-verification-client.ts, src/paypal/lib/paypal-webhook-verifier.factory.ts, src/paypal/lib/paypal-{subscription,checkout,marketplace,payout,seller-onboarding}-executor.factory.ts; tests: src/core/lib/__tests__/{webhook-intake-guards,resolve-payment-runtime}.unit.test.ts, src/paypal/lib/__tests__/{paypal-factory-production-guard,paypal-oauth-token-retry,live-paypal-webhook-verification-client}.unit.test.ts.

Concern 1 of the first pass (15-minute default blocking redeliveries) is resolved. Concerns 2-6 stand; review items 6-8 are left to T7 (docs) and T6 (payload hash on resume) as instructed.

### Updated commit message (whole T3)
```
fix(paypal): token retry on 401, raw-body verify, intake guards, prod boot checks

- OAuth cache keyed by clientId; a 401 evicts the token and resends once with
  a fresh one (single flight, same PayPal-Request-Id); a second 401 is
  PROVIDER_AUTH_FAILURE. One shared helper for all five executors and the
  webhook verify client.
- verify-webhook-signature: any non-2xx after the retry, or a 2xx without
  verification_status, is verification_unavailable; only FAILURE rejects.
- Send PayPal the original raw event text (hand-built outer JSON).
- Webhook intake rejects missing headers, bodies over maxBodyBytes (256 KiB)
  and event-id mismatches before inserting evidence; providerEventId defaults
  to the body id. Opt-in freshness (maxTransmissionAgeMs/FutureMs, deprecated
  maxTransmissionSkewMs) applies only to new event ids; options are validated.
- Live HTTP clients refuse redirects; tests for the subscription and OAuth
  fetch clients.
- Production: resolvePaymentRuntime and the factories throw
  PaymentConfigurationError instead of booting reject-only, unless
  allowRejectOnlyInProduction is set; the providerCallsEnabled kill switch
  keeps the webhook verifier up (webhooks stored pending). The verifier
  factory checks webhookId at build (requireWebhookId).

Refs #7, #15, #16, #19, #1

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
```
