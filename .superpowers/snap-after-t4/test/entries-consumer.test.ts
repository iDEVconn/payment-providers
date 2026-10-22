import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/*
 * Consumer type-check of every public entry under `moduleResolution` node10
 * (resolved only through `typesVersions`) and node16 (through `exports`), run
 * with a real `tsc` against the built package linked by name (issues #9, #10).
 */

const root = join(import.meta.dirname, '..');
const distReady = existsSync(join(root, 'dist/legacy.d.ts'));
const consumerDir = join(root, 'node_modules/.cache/entries-consumer-smoke');
const tscBin = join(root, 'node_modules/typescript/bin/tsc');

const source = `import { WebhookProcessingService, PaymentCapabilityError } from '@idevconn/payment-providers';
import type { OrderResult } from '@idevconn/payment-providers';
import { PaypalWebhookVerifier, PaypalSubscriptionExecutor } from '@idevconn/payment-providers/paypal';
import { reduceSubscription, initialSubscriptionState } from '@idevconn/payment-providers/subscription';
import { createPaypalPaymentProvider, LegacyPaymentError } from '@idevconn/payment-providers/legacy';
declare const order: OrderResult;
export { order, WebhookProcessingService, PaymentCapabilityError, PaypalWebhookVerifier, PaypalSubscriptionExecutor, reduceSubscription, initialSubscriptionState, createPaypalPaymentProvider, LegacyPaymentError };
`;

describe.skipIf(!distReady)('every entry resolves for a consumer', () => {
  beforeAll(() => {
    rmSync(consumerDir, { recursive: true, force: true });
    mkdirSync(join(consumerDir, 'node_modules/@idevconn'), { recursive: true });
    symlinkSync(root, join(consumerDir, 'node_modules/@idevconn/payment-providers'), 'dir');
    symlinkSync(
      join(root, 'node_modules/@idevconn/payment'),
      join(consumerDir, 'node_modules/@idevconn/payment'),
      'dir',
    );
    writeFileSync(join(consumerDir, 'package.json'), JSON.stringify({ name: 'consumer', private: true }));
  });

  afterAll(() => {
    rmSync(consumerDir, { recursive: true, force: true });
  });

  it.each(['node10', 'node16'])(
    'type-checks root, /paypal, /subscription and /legacy under moduleResolution %s',
    (moduleResolution) => {
      const dir = join(consumerDir, moduleResolution);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'index.ts'), source);
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
