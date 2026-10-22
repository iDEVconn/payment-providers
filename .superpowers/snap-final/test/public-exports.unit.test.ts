import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('public package exports', () => {
  it('resolves the root entrypoint with explicit configuration and recovery types', async () => {
    const root = await import('../src/index');
    expect(root.PaymentRecoveryService).toBeDefined();
    expect(root.WebhookProcessingService).toBeDefined();
    expect(root.PaymentReliabilityError).toBeDefined();
    expect(root.PAYMENT_RELIABILITY_ERROR).toBeDefined();
    expect(root.PaymentProviderConfig).toBeUndefined();
    expect(typeof root.resolvePaymentRuntime).toBe('function');
    expect(root.isRecoverableEvidenceRow).toBeDefined();
    expect(root.classifyWebhookEvidenceResume).toBeDefined();
    expect(root.EnvGetter).toBeUndefined();
    expect(root.readEnvEnabled).toBeUndefined();
    expect(root.readPaymentEnvironment).toBeUndefined();
    expect(root.PAYMENT_MS_ENV_PATH).toBeUndefined();
  });

  it('exports PaymentProviderConfig as a type from the root entrypoint', async () => {
    const root = await import('../src/index');
    const config: import('../src/core/lib/payment-provider-config').PaymentProviderConfig = {
      environment: 'sandbox',
      applicationRef: 'test-app',
    };
    expect(root.resolvePaymentRuntime({ config }).context.environment).toBe('sandbox');
  });

  it('resolves the PayPal subpath entrypoint (checkout provider lives in ./legacy)', async () => {
    const paypal = await import('../src/paypal/index');
    expect(paypal.PaypalWebhookVerifier).toBeDefined();
    expect(paypal.LivePaypalWebhookVerificationClient).toBeDefined();
    expect(paypal.createPaypalPaymentProvider).toBeUndefined();
    expect(paypal.parsePaypalEnvironmentFromEnv).toBeUndefined();
  });
});

// A pinned name list per entry point: an `export *` that starts leaking an internal helper (or a
// rename/removal of a public name) fails here. Regenerate the files after an intended change with
// `UPDATE_EXPORT_SURFACE=1 npx vitest run test/public-exports.unit.test.ts`, then review the diff.
const fixtureDir = join(import.meta.dirname, 'fixtures/export-surface');

type SurfaceFixture = { runtime: string[]; typeOnly: string[] };

function readFixture(name: string): SurfaceFixture {
  return JSON.parse(readFileSync(join(fixtureDir, `${name}.json`), 'utf8')) as SurfaceFixture;
}

async function runtimeNames(load: () => Promise<Record<string, unknown>>): Promise<string[]> {
  return Object.keys(await load())
    .filter((name) => name !== 'default')
    .sort();
}

describe('pinned runtime export surface', () => {
  const entries: Array<[string, () => Promise<Record<string, unknown>>]> = [
    ['root', () => import('../src/index')],
    ['paypal', () => import('../src/paypal/index')],
    ['subscription', () => import('../src/subscription-core/index')],
    ['testing', () => import('../src/testing/index')],
    ['legacy', () => import('../src/legacy/index')],
  ];

  for (const [name, load] of entries) {
    it(`${name} exports exactly the pinned runtime names`, async () => {
      const actual = await runtimeNames(load);
      if (process.env.UPDATE_EXPORT_SURFACE === '1') {
        const current = readFixture(name);
        writeFileSync(
          join(fixtureDir, `${name}.json`),
          `${JSON.stringify({ runtime: actual, typeOnly: current.typeOnly }, null, 2)}\n`,
        );
        return;
      }
      expect(actual).toEqual(readFixture(name).runtime);
    });
  }

  it('does not export engine internals from the root', async () => {
    const root = await import('../src/index');
    for (const internal of [
      'applySubscriptionEvents',
      'clearPendingSubscriptionEffects',
      'deliverSubscriptionEffects',
      'readHeldSubscriptionEffects',
      'resolveExpectedSubscriptionPayment',
      'normalizeSubscriptionEvidencePayload',
      'subscriptionEventFromProviderSnapshot',
      'resolveRetryBackoffPolicy',
      'resolvePositiveDurationMs',
      'retryDelayMs',
      'nextRetryDeferral',
      'isRetryDue',
    ]) {
      expect(Object.keys(root)).not.toContain(internal);
    }
    expect(typeof root.readSubscriptionOperationState).toBe('function');
    expect(typeof root.adoptSubscriptionPlan).toBe('function');
  });
});
