# T3 review (verifier, OAuth, HTTP, runtime)

Verdict: **APPROVED_WITH_FIXES**

Gate observed: `npm run lint` clean, `npm run typecheck` clean, `npm run build` ok, `npm test` 91 files / 833 tests passed.

## Evidence (probes against the new dist/, scripts in scratchpad/t3review/)

- p1 adapted (`p1.mjs`): verify 503 / html 502 / timeout / 401 / 403 / 400 / 200 without status all leave evidence
  `pending/pending err=VERIFICATION_UNAVAILABLE` and the redelivery processes it (sub `active`). Only 200 `FAILURE`
  gives `rejected/failed`. The original #1/#19 failures are gone.
- p8 adapted (`p8.mjs`): revoked cached token, 3 webhooks: 2 OAuth fetches, all 3 `verified/processed`. 10 concurrent
  401s: 2 OAuth fetches in total (initial + one refresh). A late `rejectedToken` for the old token keeps the new one.
  Executor double 401: `PROVIDER_AUTH_FAILURE`, both sends carry `requestId: REQ-1` (same PayPal-Request-Id), static message.
- Splice (`splice.mjs`): `{"a":1}}, "webhook_id":"x"`, two documents, trailing garbage, BOM, NUL, `//` comment, array,
  null, string, empty: all `invalid_payload` without a PayPal call. Whitespace/newlines around the object, `__proto__`,
  inner `webhook_id`/`cert_url`, duplicate keys, lone surrogate escape, U+2028, 200k-deep nesting: outer JSON parses,
  outer keys are exactly ours (`webhook_id=REAL-WH`), embedded text is byte-identical. No injection found.
- Production (`prod.mjs`): sandbox creds + `NODE_ENV=production` boot fine (staging ok). Error messages and
  `JSON.stringify(error)` do not contain the secret values; `missingFields` lists names only.
- Mutation check in a scratch copy: removing the raw splice, the freshness check or the token eviction makes 1, 2 and
  15+ tests fail respectively. The tests are effective.

## Findings

1. **Important**: the default freshness window blocks recovery of stored pending evidence.
   `src/core/lib/webhook-processing-service.ts:78` (default 900000) and `:192-203` (the check runs before
   `findEvidenceByProviderEvent`). Probe `fresh.mjs`: first delivery gets verify-unavailable and is stored
   `pending/pending`. A redelivery 20 min later with the original `transmissionTime` then gets
   `INVALID_REQUEST: Webhook transmission time is invalid or outside the allowed window`. The evidence stays pending and
   the subscription stays `approval_pending`. The check adds almost no security: replays are deduplicated by event id,
   the body is signature-verified, and ordering is handled by the reducer. Replaying a genuine stale event that was never
   stored only delivers a real event late. Smallest fix: default `maxTransmissionSkewMs` to `null` (off, opt-in). If it
   stays on, run it only when no evidence exists yet (after the lookup, before insert) and use a window that covers
   PayPal's retry schedule (see the recommendation below).

2. **Important**: production has no escape hatch for an intentional kill switch or a payments-off deployment.
   `src/core/lib/resolve-payment-runtime.ts:135-153` and `:169-171`, `src/paypal/lib/build-reject-only-executor.ts:26-52`,
   `src/paypal/lib/paypal-webhook-verifier.factory.ts:37-42`. `executionStatus.providerCallsEnabled=false` (the documented
   network kill switch) in `NODE_ENV=production` now throws from `resolvePaymentRuntime` and from all six factories,
   including the webhook verifier. Probe: `prod kill switch -> THROW PaymentConfigurationError`. So a host that flips the
   kill switch during an incident can no longer build a verifier, and webhooks are not even stored as pending (event
   loss, the opposite of the package's goal). If the host resolves per request, every request throws. A deployment with
   checkout disabled and no credentials must also pass a `configured` executionStatus to boot. The spec asks for the
   throw, so this is an owner decision. Smallest fix: an explicit opt-in such as `allowRejectOnlyInProduction: true` on
   `resolvePaymentRuntime` and the factories, or treat `runtimeState: 'configured'` + `providerCallsEnabled: false` as an
   intentional kill switch that is allowed. At minimum, document the behaviour in T7.

3. **Minor**: the hand-built body is invalid JSON when every outer field is undefined.
   `src/paypal/lib/live-paypal-webhook-verification-client.ts:43`. Probe `empty.mjs`: `{,"webhook_event":{}}`. This is
   reachable only from untyped callers of the public client (the verifier always sets `webhookId`). Fix:
   `const head = JSON.stringify(fields); return head === '{}' ? \`{"webhook_event":${raw}}\` : \`${head.slice(0,-1)},"webhook_event":${raw}}\``.

4. **Minor**: intake options are not validated, and a NaN `maxBodyBytes` disables the cap (fails open).
   `src/core/lib/webhook-processing-service.ts:108-114,188`: `text.length > NaN` and `byteLength > NaN` are both false.
   Fix: validate in the constructor (finite integer > 0 for `maxBodyBytes`, finite >= 0 or null for skew) and throw
   `PaymentConfigurationError`.

5. **Minor**: no test pins PayPal-Request-Id reuse on the 401 resend.
   `src/paypal/lib/__tests__/paypal-oauth-token-retry.unit.test.ts` (no `requestId` assertion). Behaviour is correct
   (probe: `REQ-1` on both sends), but a refactor that rebuilds the request could drop it. Fix: assert that both recorded
   requests of `createSubscription` and checkout `createOrder` carry the same `requestId`.

6. **Minor (docs for T7)**: a host-supplied `PaypalCheckoutTokenProvider` that ignores the new second argument returns the
   same revoked token on the retry, which yields `PROVIDER_AUTH_FAILURE` with no recovery.
   `src/paypal/lib/paypal-access-token-retry.ts:34-37`. Document that custom providers must evict on
   `options.rejectedToken`.

7. **Minor (pre-existing, widened by #19)**: resuming existing evidence does not compare the body.
   `src/core/lib/webhook-processing-service.ts:249-275`: an existing pending row is verified with the NEW request's
   `verify()` and processed with the new `rawBody`, but the stored `rawPayload` (possibly another body under the same
   id) is kept and later used by `reprocessStoredWebhookEvidence` (`:217-229`). A 400 now leaves a row pending instead of
   rejecting it, so unauthenticated garbage-header posts can park rows under chosen event ids. Exploiting this needs a
   future PayPal event id, which is unguessable in practice. Fix (T5/T6): on resume, reject or replace when
   `sha256(input.rawBody)` differs from the stored payload hash.

8. **Minor (docs)**: intake validates `input.headers`, but nothing binds them to the headers the host's `verify` closure
   sends to PayPal (`webhook-processing-service.ts:172-203`). Document that the same header object must feed both.

## `maxTransmissionSkewMs` default: recommendation

Use **`null` (off) by default**, opt-in, as the plan's own rule says: "default-on only where the old behaviour was unsafe".
The old behaviour was not unsafe here, because replay is already neutralised by event-id dedupe, PayPal signature
verification and the reducer's ordering rules. Freshness only adds a way to drop genuine events. PayPal retries failed
deliveries for about 3 days (up to 25 attempts). Whether a retry keeps the original `PAYPAL-TRANSMISSION-TIME` is not
confirmed, and a 15 minute window would lose every late retry if it does. Host clock drift and queued or replayed ingress
(DLQ, manual "resend") make it worse. If a host wants the check:

- apply it only to events not seen before;
- accept at least 72 h in the past (the retry window plus margin) and a small future skew (5 min);
- verify the redelivery behaviour against the sandbox before tightening it.
