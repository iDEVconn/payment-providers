import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/*
 * Consumer smoke checks for the `./subscription` entry, run against the built
 * package the way an installed consumer sees it: a scratch project under
 * node_modules/.cache links the package by name and resolves it through the
 * `exports` map (ESM and CJS) and through `typesVersions` (TypeScript
 * `moduleResolution: node10`).
 */

const root = join(import.meta.dirname, '..');
const distReady = existsSync(join(root, 'dist/subscription.js'));
const consumerDir = join(root, 'node_modules/.cache/subscription-consumer-smoke');
const tscBin = join(root, 'node_modules/typescript/bin/tsc');

function run(args: string[]): string {
  return execFileSync(process.execPath, args, { cwd: consumerDir, encoding: 'utf8' });
}

describe.skipIf(!distReady)('subscription entry consumer smoke', () => {
  beforeAll(() => {
    rmSync(consumerDir, { recursive: true, force: true });
    mkdirSync(join(consumerDir, 'node_modules/@idevconn'), { recursive: true });
    symlinkSync(root, join(consumerDir, 'node_modules/@idevconn/payment-providers'), 'dir');
    writeFileSync(join(consumerDir, 'package.json'), JSON.stringify({ name: 'consumer', private: true }));
  });

  afterAll(() => {
    rmSync(consumerDir, { recursive: true, force: true });
  });

  it('loads the built ESM and CJS files directly', async () => {
    const esm = await import(pathToFileURL(join(root, 'dist/subscription.js')).href);
    const require = createRequire(import.meta.url);
    const cjs = require(join(root, 'dist/subscription.cjs'));
    for (const mod of [esm, cjs]) {
      expect(typeof mod.reduceSubscription).toBe('function');
      expect(typeof mod.normalizePaypalSubscriptionEvent).toBe('function');
      expect(typeof mod.isFreshTransmission).toBe('function');
    }
  });

  it('resolves @idevconn/payment-providers/subscription under ESM import', () => {
    const out = run([
      '--input-type=module',
      '-e',
      `import { reduceSubscription, initialSubscriptionState, normalizePaypalSubscriptionEvent } from '@idevconn/payment-providers/subscription';
       const n = normalizePaypalSubscriptionEvent(JSON.stringify({ id: 'WH-1', event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 'I-1' } }));
       console.log(reduceSubscription(initialSubscriptionState(), n.event, { source: 'webhook' }).state.status);`,
    ]);
    expect(out.trim()).toBe('active');
  });

  it('resolves @idevconn/payment-providers/subscription under CJS require without loading the legacy runtime', () => {
    const out = run([
      '-e',
      `const sub = require('@idevconn/payment-providers/subscription');
       const loaded = Object.keys(require.cache).filter((k) => /node_modules[\\\\/](axios|zod|express|@idevconn[\\\\/]payment[\\\\/])/.test(k));
       console.log(typeof sub.reduceSubscription, loaded.length);`,
    ]);
    expect(out.trim()).toBe('function 0');
  });

  it.each(['node10', 'node16'])(
    'type-checks a consumer under moduleResolution %s',
    (moduleResolution) => {
      const dir = join(consumerDir, moduleResolution);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'index.ts'),
        `import { reduceSubscription, initialSubscriptionState, type SubscriptionState, type NormalizedSubscriptionEvent } from '@idevconn/payment-providers/subscription';
         import { WebhookProcessingService } from '@idevconn/payment-providers';
         import { PaypalWebhookVerifier } from '@idevconn/payment-providers/paypal';
         declare const event: NormalizedSubscriptionEvent;
         const state: SubscriptionState = initialSubscriptionState();
         const next: SubscriptionState = reduceSubscription(state, event, { source: 'lookup' }).state;
         export { next, WebhookProcessingService, PaypalWebhookVerifier };
        `,
      );
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: moduleResolution === 'node10' ? 'commonjs' : 'node16',
            moduleResolution,
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            types: [],
          },
          files: ['index.ts'],
        }),
      );
      const result = (() => {
        try {
          return execFileSync(process.execPath, [tscBin, '-p', join(dir, 'tsconfig.json')], {
            cwd: dir,
            encoding: 'utf8',
          });
        } catch (error) {
          const failure = error as { stdout?: string; stderr?: string };
          return `FAILED\n${failure.stdout ?? ''}${failure.stderr ?? ''}`;
        }
      })();
      expect(result).toBe('');
    },
    60_000,
  );
});
