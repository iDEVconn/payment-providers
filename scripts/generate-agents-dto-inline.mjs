/**
 * Generates inline DTO field tables for AGENTS.md from contract source.
 * Run: node scripts/generate-agents-dto-inline.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const contractsDir = path.join(root, 'src/contracts/lib');

const CONTEXT_FIELDS = {
  CheckoutProviderContext: [
    f('providerCode', 'string', true, 'Consumer caller', 'Module + provider port', 'Provider identifier (for example paypal).'),
    f('accountRef', 'string', true, 'Consumer caller', 'Module store + provider port', 'Logical payment account scope.'),
    f('applicationRef', 'string', true, 'Consumer caller', 'Module store + provider port', 'Tenant application identifier (required on config).'),
    f('environment', `sandbox \\| live`, true, 'Consumer caller', 'Module + provider port', 'PayPal API environment target.'),
  ],
  PayoutProviderContext: 'CheckoutProviderContext',
  SubscriptionProviderContext: 'CheckoutProviderContext',
  SellerOnboardingProviderContext: 'CheckoutProviderContext',
};

function f(name, type, required, producer, consumer, meaning) {
  return { name, type, required, producer, consumer, meaning };
}

function expandContext(name) {
  const def = CONTEXT_FIELDS[name];
  if (typeof def === 'string') return expandContext(def);
  return def ?? [];
}

function parseObjectFields(body) {
  const fields = [];
  const lines = body.split('\n');
  for (const line of lines) {
    const m = line.match(/^\s*(\w+)(\?)?:\s*(.+?);?\s*$/);
    if (!m) continue;
    fields.push({
      name: m[1],
      type: m[3].replace(/;$/, '').trim(),
      required: !m[2],
      producer: inferProducer(m[1]),
      consumer: inferConsumer(m[1]),
      meaning: inferMeaning(m[1]),
    });
  }
  return fields;
}

function inferProducer(name) {
  if (name.startsWith('provider') && name !== 'providerCode') return 'Provider adapter / module';
  if (name === 'operationId' || name.endsWith('OperationId')) return 'Module lifecycle';
  if (name === 'outcome' || name === 'nextAction' || name === 'failure') return 'Module lifecycle';
  if (name === 'verify') return 'Consumer HTTP handler';
  return 'Consumer caller';
}

function inferConsumer(name) {
  if (name.startsWith('provider') && !name.endsWith('RequestId')) return 'Module persistence + reconciliation';
  if (name === 'idempotencyKey' || name === 'correlationId') return 'Module store';
  if (name === 'providerRequestId') return 'Provider port implementation';
  if (name === 'outcome' || name === 'failure') return 'Consumer caller / RPC mapper';
  return 'Module lifecycle';
}

function inferMeaning(name) {
  const map = {
    idempotencyKey: 'Command deduplication key within idempotency scope.',
    correlationId: 'Optional consumer tracing reference stored on the operation.',
    providerRequestId: 'Module-generated idempotency token for a single provider HTTP attempt.',
    amountMinor: 'Integer minor units as decimal string (see CanonicalMoney).',
    currencyCode: 'ISO currency code paired with amountMinor on store rows.',
    rawBody: 'Exact webhook body bytes/string for verification and replay.',
    payloadSha256: 'Hash of rawPayload for integrity checks.',
    workerId: 'Recovery/reconciliation worker identity for claim leases.',
    limit: 'Maximum rows or candidates processed in one batch.',
    leaseMs: 'Claim lease duration in milliseconds.',
  };
  return map[name] ?? `Field \`${name}\` on this DTO (see source semantics).`;
}

function extractTypes(source) {
  const types = [];
  const re = /export type (\w+)\s*=\s*([\s\S]*?);(?=\n\n|export |$)/g;
  let m;
  while ((m = re.exec(source))) {
    types.push({ name: m[1], body: m[2].trim() });
  }
  return types;
}

function fieldsForType(body) {
  const fields = [];
  const parts = body.split('&').map((p) => p.trim());
  for (const part of parts) {
    const ctx = part.match(/^(\w+ProviderContext)$/);
    if (ctx) {
      fields.push(...expandContext(ctx[1]));
      continue;
    }
    if (part.startsWith('{') || part.includes('{')) {
      const inner = part.replace(/^\(/, '').replace(/\)$/, '');
      const obj = inner.match(/\{([\s\S]*)\}/);
      if (obj) fields.push(...parseObjectFields(obj[1]));
    }
  }
  if (body.startsWith('{') && !body.includes('&')) {
    fields.push(...parseObjectFields(body.slice(1, -1)));
  }
  return dedupeFields(fields);
}

function dedupeFields(fields) {
  const seen = new Set();
  return fields.filter((row) => {
    if (seen.has(row.name)) return false;
    seen.add(row.name);
    return true;
  });
}

function renderTable(typeName, fields) {
  if (fields.length === 0) return '';
  let md = `#### \`${typeName}\`\n\n`;
  md += '| Field | Type | Required | Producer | Consumer | Meaning |\n| --- | --- | ---: | --- | --- | --- |\n';
  for (const row of fields) {
    const typeCell = row.type.replace(/\|/g, '\\|');
    md += `| \`${row.name}\` | \`${typeCell}\` | ${row.required ? 'yes' : 'no'} | ${row.producer} | ${row.consumer} | ${row.meaning} |\n`;
  }
  md += '\n';
  return md;
}

function shouldInclude(name) {
  if (name.endsWith('Status') && !name.includes('Result') && !name.includes('Request')) {
    if (!['CheckoutOrderStatus', 'MarketplaceOrderStatus', 'MarketplaceUnitStatus', 'RefundStatus'].includes(name))
      return false;
  }
  if (/^(ProductType|PlanStatus|SubscriptionStatus|PayoutFinancialStatus|PayoutRecipientType|BillingIntervalUnit|BillingTenureType|PaymentResultOutcome|PaymentNextAction|PaymentFailureCategory|PaymentCauseCode|EvidenceVerificationStatus|EvidenceProcessingStatus|ConsumerDeliveryStatus|ProviderEvidenceKind|VerifyWebhookFailureKind|CheckoutProviderCreateRetryEligibility|SubscriptionProviderCreateRetryEligibility)$/.test(name))
    return false;
  return /^(Create|Get|Execute|Submit|Cancel|Capture|Refund|Retry|Reconcile|Plan|Subscription|Catalog|Billing|Seller|Marketplace|Insert|Update|Transition|Recover|Claim|List|Verify|Webhook|Normalized|Classified|PaymentEvidence|Receive|Canonical|BillingCycle|PaymentPreferences|Subscriber|MarketplaceUnit|Payout|SubmitPayout|CancelUnclaimed|RefundCapture|CreateSeller|UpdateSeller|UpdateMarketplace|InsertMarketplace|UpdateProvider|InsertProvider|InsertReconciliation|ReconcilePayment|ReconcileSeller|GetSeller|GetPayout|GetBilling|GetCatalog|GetSubscription|GetCheckout|GetMarketplace|CheckoutOrder|CheckoutCapture|RefundMarketplace|MarketplaceOrder|MarketplaceUnit|SellerReferral|SellerConnection|SubmitPayout|PaymentOperation|CreatePayment|TransitionPayment|UpdatePayment|ProviderEvidence|RecoverPayment|ListPayment|PaymentEvidenceAdmin|VerifiedProcessed|ResolvePayment|PaymentRecovery|AcquireCheckout|ApplyPayout|ApplyPlan|ApplySubscription|ExecuteSubscriptionLifecycle|ExecuteMarketplaceUnitSnapshot|ExecuteSubscriptionLifecycleRefresh|ExecuteSubscriptionLifecycleRefreshed|PayoutBatchItem|SubmitPayoutBatch|GetPayoutItem|CancelUnclaimed|RefundCapture|ExecuteRefund|ExecuteGet|ExecuteCreate|ExecuteCapture|ExecuteSubmit|ExecuteCancel|ExecutePlan|ExecuteFind|ExecuteGetSeller|ExecuteRefundMarketplace|MarketplacePurchaseUnit|CreateSellerConnection|UpdateSellerConnection|ReconciliationAttempt|PaypalWebhookTransmission)/.test(name);
}

const extraTypes = [
  {
    name: 'CanonicalMoney',
    fields: [
      f('currency', 'string', true, 'Consumer caller', 'Module + provider port', 'ISO currency code.'),
      f('amountMinor', 'string', true, 'Consumer caller', 'Module + provider port', 'Integer amount in minor units encoded as a decimal string (not major units).'),
    ],
  },
  {
    name: 'ReceiveWebhookInput',
    file: 'webhook-processing-service.ts',
    fields: [
      f('providerCode', 'string', true, 'Consumer HTTP handler', 'WebhookProcessingService', 'Provider routing scope.'),
      f('accountRef', 'string', true, 'Consumer HTTP handler', 'WebhookProcessingService', 'Account routing scope.'),
      f('applicationRef', 'string', true, 'Consumer HTTP handler', 'WebhookProcessingService', 'Application tenant scope.'),
      f('environment', `sandbox \\| live`, true, 'Consumer HTTP handler', 'WebhookProcessingService', 'Environment scope.'),
      f('rawBody', 'string', true, 'Consumer HTTP handler', 'WebhookProcessingService', 'Raw webhook body for verify + evidence insert.'),
      f('providerEventId', 'string', true, 'Consumer HTTP handler', 'WebhookProcessingService', 'Stable provider event id (PayPal transmission id).'),
      f('verify', '() => Promise<VerifyWebhookResult>', true, 'Consumer HTTP handler', 'WebhookProcessingService', 'Verification callback (typically PaypalWebhookVerifier.verify).'),
    ],
  },
  {
    name: 'VerifiedProcessedPaymentEvent',
    file: 'payment-event-consumer.ts',
    fields: [
      f('evidenceId', 'string', true, 'Module', 'PaymentEventConsumer', 'Evidence row primary key.'),
      f('providerCode', 'string', true, 'Module', 'PaymentEventConsumer', 'Scope field from evidence.'),
      f('accountRef', 'string', true, 'Module', 'PaymentEventConsumer', 'Scope field from evidence.'),
      f('applicationRef', 'string', true, 'Module', 'PaymentEventConsumer', 'Scope field from evidence.'),
      f('environment', `sandbox \\| live`, true, 'Module', 'PaymentEventConsumer', 'Scope field from evidence.'),
      f('eventType', 'string | null', true, 'Module', 'PaymentEventConsumer', 'Provider event type after processing.'),
      f('resourceId', 'string | null', true, 'Module', 'PaymentEventConsumer', 'Provider resource id from webhook.'),
      f('relatedOperationId', 'string | null', true, 'Module', 'PaymentEventConsumer', 'Linked payment operation when correlated.'),
      f('processingStatus', 'EvidenceProcessingStatus', true, 'Module', 'PaymentEventConsumer', 'Processing dimension on evidence.'),
      f('verificationStatus', 'EvidenceVerificationStatus', true, 'Module', 'PaymentEventConsumer', 'Verification dimension on evidence.'),
    ],
  },
  {
    name: 'NormalizedPaymentFailure',
    file: 'operation-result.ts',
    fields: [
      f('code', 'string', true, 'Module', 'Consumer RPC mapper', 'Stable reliability or capability code.'),
      f('category', 'PaymentFailureCategory', true, 'Module', 'Consumer RPC mapper', 'Failure category for UX/routing.'),
      f('causeCode', 'PaymentCauseCode | string', true, 'Module', 'Consumer RPC mapper', 'Stable cause code from PAYMENT_CAUSE_CODE.'),
      f('nextAction', 'PaymentNextAction', true, 'Module', 'Consumer RPC mapper', 'Guidance only; not authorization to retry.'),
    ],
  },
  {
    name: 'ClassifiedPaymentFailure',
    file: 'operation-result.ts',
    fields: [
      f('code', 'string', true, 'Module', 'Server logs / toPublicFailure', 'Same as NormalizedPaymentFailure.code.'),
      f('category', 'PaymentFailureCategory', true, 'Module', 'Server logs / toPublicFailure', 'Same as NormalizedPaymentFailure.category.'),
      f('causeCode', 'PaymentCauseCode | string', true, 'Module', 'Server logs / toPublicFailure', 'Same as NormalizedPaymentFailure.causeCode.'),
      f('nextAction', 'PaymentNextAction', true, 'Module', 'Server logs / toPublicFailure', 'Same as NormalizedPaymentFailure.nextAction.'),
      f('uncertain', 'boolean', true, 'Module', 'Server only', 'Whether provider outcome is uncertain.'),
      f('retryable', 'boolean', true, 'Module', 'Server only', 'Whether retry may be safe (still enforce idempotency).'),
      f('diagnosticMessage', 'string', true, 'Module', 'Server only', 'Sanitized diagnostic; not customer copy.'),
    ],
  },
];

const contractFiles = fs
  .readdirSync(contractsDir)
  .filter((name) => name.endsWith('.ts') && !name.includes('.test.'))
  .sort();

let md = `### DTO field tables (complete inline reference)

Column semantics: **Producer** creates the field value; **Consumer** reads or persists it. **Required** means the field must be present when sending that DTO shape (optional properties may be omitted).

#### Shared provider contexts

${renderTable('CheckoutProviderContext', expandContext('CheckoutProviderContext'))}
${renderTable('PayoutProviderContext', expandContext('PayoutProviderContext'))}
${renderTable('SubscriptionProviderContext', expandContext('SubscriptionProviderContext'))}
${renderTable('SellerOnboardingProviderContext', expandContext('SellerOnboardingProviderContext'))}

`;

for (const file of contractFiles) {
  const source = fs.readFileSync(path.join(contractsDir, file), 'utf8');
  const types = extractTypes(source);
  const section = [];
  for (const t of types) {
    if (!shouldInclude(t.name)) continue;
    if (t.body.includes('|') && t.body.includes('outcome')) {
      section.push(
        `#### \`${t.name}\`\n\nDiscriminated union on \`outcome\`. Shared base fields plus outcome-specific fields — see \`src/contracts/lib/${file}\`. Always includes operation identifiers; on \`outcome: 'failed'\` includes \`failure: NormalizedPaymentFailure\`; on \`outcome: 'unknown'\` includes \`uncertaintyReason\`.\n\n`,
      );
      continue;
    }
    const fields = fieldsForType(t.body);
    if (fields.length) section.push(renderTable(t.name, fields));
  }
  if (section.length) {
    md += `### \`${file}\`\n\n${section.join('')}`;
  }
}

for (const extra of extraTypes) {
  md += renderTable(extra.name, extra.fields);
}

const coreExtras = [
  path.join(root, 'src/core/lib/webhook-processing-service.ts'),
  path.join(root, 'src/core/lib/payment-event-consumer.ts'),
];
for (const file of coreExtras) {
  const base = path.basename(file);
  const source = fs.readFileSync(file, 'utf8');
  for (const t of extractTypes(source)) {
    if (!shouldInclude(t.name) && t.name !== 'ReceiveWebhookInput' && t.name !== 'VerifiedProcessedPaymentEvent')
      continue;
    const manual = extraTypes.find((e) => e.name === t.name);
    if (manual) continue;
    const fields = fieldsForType(t.body);
    if (fields.length) md += `### \`${base}\` — \`${t.name}\`\n\n${renderTable(t.name, fields)}`;
  }
}

const out = path.join(root, 'scripts/.agents-dto-inline.generated.md');
fs.writeFileSync(out, md);
console.error('Wrote', out, 'lines', md.split('\n').length);
