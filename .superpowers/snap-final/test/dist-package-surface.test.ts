import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const distReady = existsSync(join(root, 'dist/index.js'));

describe.skipIf(!distReady)('built package surface', () => {
  it('loads ESM root and paypal subpath from dist', async () => {
    const pkgRoot = await import(pathToFileURL(join(root, 'dist/index.js')).href);
    const paypal = await import(pathToFileURL(join(root, 'dist/paypal.js')).href);
    expect(pkgRoot.PaymentRecoveryService).toBeDefined();
    expect(paypal.PaypalWebhookVerifier).toBeDefined();
  });

  it('loads CommonJS root when require is supported', () => {
    const require = createRequire(import.meta.url);
    const cjs = require(join(root, 'dist/index.cjs'));
    expect(cjs.WebhookProcessingService).toBeDefined();
  });

  it('declaration files do not reference workspace aliases', () => {
    const dtsFiles = readdirSync(join(root, 'dist')).filter((f) => f.endsWith('.d.ts'));
    for (const file of dtsFiles) {
      const text = readFileSync(join(root, 'dist', file), 'utf8');
      expect(text).not.toMatch(/@icore\//);
      expect(text).not.toMatch(/EmployeeDrivenContent/);
    }
  });

  it('export map keys exist on disk', () => {
    expect(existsSync(join(root, 'dist/index.js'))).toBe(true);
    expect(existsSync(join(root, 'dist/index.cjs'))).toBe(true);
    expect(existsSync(join(root, 'dist/paypal.js'))).toBe(true);
    expect(existsSync(join(root, 'dist/paypal.cjs'))).toBe(true);
    expect(existsSync(join(root, 'dist/subscription.js'))).toBe(true);
    expect(existsSync(join(root, 'dist/subscription.cjs'))).toBe(true);
    expect(existsSync(join(root, 'dist/subscription.d.ts'))).toBe(true);
    expect(existsSync(join(root, 'dist/subscription.d.cts'))).toBe(true);
    expect(existsSync(join(root, 'dist/testing.js'))).toBe(true);
    expect(existsSync(join(root, 'dist/testing.cjs'))).toBe(true);
    expect(existsSync(join(root, 'dist/testing.d.ts'))).toBe(true);
    expect(existsSync(join(root, 'dist/testing.d.cts'))).toBe(true);
  });

  it('loads the subscription subpath from dist (ESM and CJS)', async () => {
    const esm = await import(pathToFileURL(join(root, 'dist/subscription.js')).href);
    const require = createRequire(import.meta.url);
    const cjs = require(join(root, 'dist/subscription.cjs'));
    expect(esm.reduceSubscription).toBeDefined();
    expect(cjs.reduceSubscription).toBeDefined();
  });
});

describe('dist output (informational when not built)', () => {
  it('documents whether dist is present for surface tests', () => {
    expect(typeof distReady).toBe('boolean');
  });
});
