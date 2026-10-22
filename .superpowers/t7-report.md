# T7 report: docs, changeset, export list, final gate

Status: DONE_WITH_CONCERNS. Nothing committed, no git state changed.

## Files changed by T7 (vs .superpowers/snap-after-t6b/; ci.yml also carried the owner's smoke-step edit)
- src/core/index.ts (explicit lists for subscription-evidence-application and retry-backoff)
- test/public-exports.unit.test.ts (pinned runtime names of root, /paypal, /subscription, /testing, /legacy + internals-not-exported test)
- test/dist-export-surface.test.ts (new; pins declaration names via the TS API on dist)
- test/fixtures/export-surface/{root,paypal,subscription,testing,legacy}.json (new)
- README.md (rewrite pass), .changeset/pure-subscription-core-and-reliability.md (new), .superpowers/pr-body.md, .superpowers/t7-report.md
- .github/workflows/ci.yml (smoke step lists dist-export-surface + comment), .github/workflows/release.yml (verify job now lists testing-entry-consumer, dist-declarations, dist-export-surface)

## Export list
Removed from the root (all absent from 0.2.1, proved by building 0.2.1 in scratch and diffing runtime keys and declaration names of root and /paypal): applySubscriptionEvents, clearPendingSubscriptionEffects, deliverSubscriptionEffects, readHeldSubscriptionEffects, resolveExpectedSubscriptionPayment, normalizeSubscriptionEvidencePayload, subscriptionEventFromProviderSnapshot, resolveRetryBackoffPolicy, resolvePositiveDurationMs, retryDelayMs, nextRetryDeferral, isRetryDue, plus hasRetryState, CLEARED_RETRY_STATE, clearResolvedOperationRetryState (grep: no doc, test or other entry imports them from the root) and the types ApplySubscriptionEventsInput/Result, SubscriptionEventStep (only describe the removed function).
Kept: readSubscriptionOperationState, adoptSubscriptionPlan + types, hook types, WebhookEventPayloadMismatchError, the codes, retry defaults/limits/types, RETRY_STATUS, pathSegment, store interfaces.
Diff vs 0.2.1 after the change: root lost only LegacyPaymentError (value+type), /paypal lost only the four documented moves. Tests written first: both failed against the leaking build, pass now; UPDATE_EXPORT_SURFACE=1 regenerates the fixtures (idempotent).
Ruling: only the two leaky modules got explicit lists; the other `export *` modules contain only names that are public by design, and the pin test now guards them.

## README
Rewritten sections: intro, install (optional peer + express@^5), entry table (5 entries), "Which side owns what", production guards (allowRejectOnlyInProduction, kill switch, requireWebhookId), token provider rejectedToken, end-to-end webhook route (headers, raw body, intake options table, optional providerEventId, status mapping), store guide with Postgres DDL (all columns, partial unique indexes, indexes, lease claim with SKIP LOCKED + sort after RETURNING, 0.2->0.3 migration, gave_up alert/reset), "Upgrading from 0.2.x", "Known limits". Fixed stale parts: verify example lacked providerCode/accountRef/environment, quick start verifier lacked webhookId, recovery cannot verify pending rows after a kill switch.
Verified: all 4 SQL blocks executed on a throwaway Postgres 16 (schema, claim with PREPARE, migration of a derived 0.2 schema, alert query); all 8 TS blocks type-check against the built package (node16).
Ruling: README says the 0.2.x-rejected rows are reset with verification_status='pending', error_code NULL (classifyWebhookEvidenceResume resumes pending rows).

## Gate
lint clean, typecheck clean, build clean, npm test 111 files / 1090 tests (T6b: 110 / 1079; +1 file, +11 tests), smoke set 7 files / 42 tests, npm audit 0 vulnerabilities, npm pack --dry-run 67 files, 720.5 kB packed, 4.1 MB unpacked.

## Concerns
- AGENTS.md still describes the extraction era and is linked from the README; not touched.
- release.yml verify job now runs the extra smoke files (owner may want to review the one-line change).
- Changeset assumes version 0.3.0 wording in README ("before 0.3").
