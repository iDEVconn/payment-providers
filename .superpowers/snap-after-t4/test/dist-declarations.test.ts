import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/*
 * `@idevconn/payment` is an optional peer, so the declarations of root, /paypal and
 * /subscription must not mention it (issue #10). The package is copied (not linked)
 * into a temp consumer outside this repo, so `@idevconn/payment` cannot resolve there,
 * and checked with `skipLibCheck: false`.
 */

const root = join(import.meta.dirname, '..');
const distReady = existsSync(join(root, 'dist/legacy.d.ts'));
const consumerDir = mkdtempSync(join(tmpdir(), 'pp-declarations-'));
const pkgDir = join(consumerDir, 'node_modules/@idevconn/payment-providers');
const tscBin = join(root, 'node_modules/typescript/bin/tsc');

/** Declaration files reachable from an entry's `.d.ts`/`.d.cts` through relative imports. */
function reachableDeclarations(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(join(root, 'dist', file), 'utf8');
    for (const match of text.matchAll(/from ['"]\.\/([^'"]+)['"]/g)) {
      const base = match[1] as string;
      const ext = file.endsWith('.d.cts') ? '.d.cts' : '.d.ts';
      queue.push(base.endsWith('.js') || base.endsWith('.cjs') ? base.replace(/\.c?js$/, ext) : `${base}${ext}`);
    }
  }
  return [...seen];
}

describe.skipIf(!distReady)('declarations of root, /paypal and /subscription are free of @idevconn/payment', () => {
  beforeAll(() => {
    mkdirSync(pkgDir, { recursive: true });
    cpSync(join(root, 'dist'), join(pkgDir, 'dist'), { recursive: true });
    cpSync(join(root, 'package.json'), join(pkgDir, 'package.json'));
    writeFileSync(join(consumerDir, 'package.json'), JSON.stringify({ name: 'consumer', private: true }));
  });

  afterAll(() => {
    rmSync(consumerDir, { recursive: true, force: true });
  });

  it.each(['index', 'paypal', 'subscription'])('dist/%s declarations and their shared chunks do not mention it', (entry) => {
    for (const ext of ['.d.ts', '.d.cts']) {
      for (const file of reachableDeclarations(`${entry}${ext}`)) {
        expect(readFileSync(join(root, 'dist', file), 'utf8'), file).not.toContain('@idevconn/payment"');
        expect(readFileSync(join(root, 'dist', file), 'utf8'), file).not.toContain("@idevconn/payment'");
      }
    }
  });

  it('keeps the legacy entry on the real @idevconn/payment types', () => {
    expect(readFileSync(join(root, 'dist/legacy.d.ts'), 'utf8')).toContain('@idevconn/payment');
    expect(readdirSync(join(root, 'dist')).length).toBeGreaterThan(0);
  });

  it.each(['node10', 'node16'])(
    'type-checks root, /paypal and /subscription with skipLibCheck false under %s without @idevconn/payment installed',
    (moduleResolution) => {
      const dir = join(consumerDir, moduleResolution);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'index.ts'),
        `import { WebhookProcessingService, PaymentCapabilityError } from '@idevconn/payment-providers';
         import type { OrderResult, PaymentStrategy } from '@idevconn/payment-providers';
         import { PaypalWebhookVerifier, PaypalCheckoutExecutor, buildPaypalCheckoutExecutor } from '@idevconn/payment-providers/paypal';
         import { reduceSubscription } from '@idevconn/payment-providers/subscription';
         declare const order: OrderResult;
         declare const strategy: PaymentStrategy;
         export { order, strategy, WebhookProcessingService, PaymentCapabilityError, PaypalWebhookVerifier, PaypalCheckoutExecutor, buildPaypalCheckoutExecutor, reduceSubscription };
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
            skipLibCheck: false,
            types: [],
          },
          files: ['index.ts'],
        }),
      );
      const result = (() => {
        try {
          return execFileSync(process.execPath, [tscBin, '-p', join(dir, 'tsconfig.json')], { cwd: dir, encoding: 'utf8' });
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
