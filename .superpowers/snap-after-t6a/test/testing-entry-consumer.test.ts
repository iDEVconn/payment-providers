import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/*
 * Consumer smoke checks for the `./testing` entry (store conformance kit), run against the built
 * package linked by name: ESM import, CJS require (without loading any test runner), and
 * TypeScript under `moduleResolution` node10 (`typesVersions`) and node16 (`exports`). The kit
 * runs end to end with a tiny hand-written runner, so it needs no vitest at runtime.
 */

const root = join(import.meta.dirname, '..');
const distReady = existsSync(join(root, 'dist/testing.js'));
const consumerDir = join(root, 'node_modules/.cache/testing-consumer-smoke');
const tscBin = join(root, 'node_modules/typescript/bin/tsc');

function run(args: string[]): string {
  return execFileSync(process.execPath, args, {
    cwd: consumerDir,
    encoding: 'utf8',
  });
}

// A minimal runner: collects cases, runs them in order, prints the failures.
const miniRunner = `
  const cases = [];
  const path = [];
  const describe = (name, fn) => { path.push(name); fn(); path.pop(); };
  const it = (name, fn) => cases.push({ name: [...path, name].join(' > '), fn });
  const expect = (actual, message) => ({
    toBe: (expected) => { if (!Object.is(actual, expected)) throw new Error((message ?? '') + ' toBe'); },
    toEqual: (expected) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error((message ?? '') + ' toEqual'); },
  });
`;

const runAll = `
  testing.runStoreConformance({
    createStore: () => new core.MemoryPaymentReliabilityStore(),
    describe, it, expect,
    capabilities: { checkout: true, payout: true, seller: true, marketplace: true },
    leaseExpiryWaitMs: 40,
  });
  const failed = [];
  for (const c of cases) { try { await c.fn(); } catch (e) { failed.push(c.name + ': ' + e.message); } }
  const loaded = typeof require === 'undefined' ? [] : Object.keys(require.cache).filter((k) => /node_modules[\\\\/](vitest|jest|@vitest)[\\\\/]/.test(k));
  console.log(JSON.stringify({ cases: cases.length, failed, loaded }));
`;

describe.skipIf(!distReady)('testing entry consumer smoke', () => {
  beforeAll(() => {
    rmSync(consumerDir, { recursive: true, force: true });
    mkdirSync(join(consumerDir, 'node_modules/@idevconn'), { recursive: true });
    symlinkSync(root, join(consumerDir, 'node_modules/@idevconn/payment-providers'), 'dir');
    writeFileSync(
      join(consumerDir, 'package.json'),
      JSON.stringify({ name: 'consumer', private: true }),
    );
  });

  afterAll(() => {
    rmSync(consumerDir, { recursive: true, force: true });
  });

  it('loads the built ESM and CJS files directly', async () => {
    const esm = await import(pathToFileURL(join(root, 'dist/testing.js')).href);
    const require = createRequire(import.meta.url);
    const cjs = require(join(root, 'dist/testing.cjs'));
    for (const mod of [esm, cjs]) {
      expect(typeof mod.runStoreConformance).toBe('function');
    }
  });

  it('runs the kit against the memory store under ESM import with no test runner installed', () => {
    const out = run([
      '--input-type=module',
      '-e',
      `import * as testing from '@idevconn/payment-providers/testing';
       import * as core from '@idevconn/payment-providers';
       ${miniRunner}
       ${runAll}`,
    ]);
    const result = JSON.parse(out);
    expect(result.failed).toEqual([]);
    expect(result.cases).toBeGreaterThan(30);
  }, 30_000);

  it('runs the kit under CJS require without loading vitest or jest', () => {
    const out = run([
      '-e',
      `const testing = require('@idevconn/payment-providers/testing');
       const core = require('@idevconn/payment-providers');
       (async () => {
         ${miniRunner}
         ${runAll}
       })();`,
    ]);
    const result = JSON.parse(out);
    expect(result.failed).toEqual([]);
    expect(result.loaded).toEqual([]);
  }, 30_000);

  it.each(['node10', 'node16'])(
    'type-checks a consumer under moduleResolution %s',
    (moduleResolution) => {
      const dir = join(consumerDir, moduleResolution);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'index.ts'),
        `import { runStoreConformance, type ConformanceExpect } from '@idevconn/payment-providers/testing';
         import { MemoryPaymentReliabilityStore, type SubscriptionStore } from '@idevconn/payment-providers';
         declare const expect: ConformanceExpect;
         const createStore = (): SubscriptionStore => new MemoryPaymentReliabilityStore();
         runStoreConformance({
           createStore,
           describe: (_name: string, fn: () => void) => fn(),
           it: (_name: string, _fn: () => Promise<void>) => undefined,
           expect,
           capabilities: { checkout: false },
         });
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
