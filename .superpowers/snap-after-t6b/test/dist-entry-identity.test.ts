import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/*
 * Built-package checks run in a fresh `node` process against dist/, so the module
 * graph is the one a consumer gets: core classes must be one copy across entries
 * (issue #9), and the entries must not load the legacy checkout runtime (issue #10).
 */

const root = join(import.meta.dirname, '..');
const distReady = existsSync(join(root, 'dist/index.js'));
const scratch = mkdtempSync(join(tmpdir(), 'pp-entry-identity-'));

const identityBody = (load: (name: string) => string) => `
  const core = ${load('index')};
  const pp = ${load('paypal')};
  const sub = ${load('subscription')};
  const ctx = { providerCode: 'paypal', accountRef: 'a', applicationRef: 'x', environment: 'sandbox' };
  const runtime = { mode: 'live-provider', context: ctx, descriptor: { ...ctx, capabilities: core.evaluateCapabilities({ applicationRef: 'x', environment: 'sandbox' }, ctx) } };
  const executor = new pp.PaypalSubscriptionExecutor(runtime, { request: async () => ({}) }, async () => 't');
  const thrown = await executor.getPlan({ ...ctx, providerPlanId: 'P' }).then(() => null, (e) => e);
  console.log(JSON.stringify({
    capability: thrown instanceof core.PaymentCapabilityError,
    configuration: new pp.PaypalWebhookVerifier !== undefined,
    subscriptionEntry: typeof sub.reduceSubscription,
  }));
`;

function runNode(args: string[]): string {
  return execFileSync(process.execPath, args, { cwd: scratch, encoding: 'utf8' });
}

const blockedSpecifier = /^(axios|zod|express|@idevconn\/payment)(\/|$)/;

describe.skipIf(!distReady)('built entries share one core and stay free of the legacy runtime', () => {
  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('shares PaymentCapabilityError between root and paypal under CJS require', () => {
    const script = join(scratch, 'identity.cjs');
    const load = (name: string) => `require(${JSON.stringify(join(root, `dist/${name}.cjs`))})`;
    writeFileSync(script, `(async () => {${identityBody(load).replace('new pp.PaypalWebhookVerifier !== undefined', 'typeof pp.PaypalWebhookVerifier')}})();`);
    const out = JSON.parse(runNode([script]));
    expect(out.capability).toBe(true);
    expect(out.subscriptionEntry).toBe('function');
  });

  it('shares PaymentCapabilityError between root and paypal under ESM import', () => {
    const script = join(scratch, 'identity.mjs');
    const load = (name: string) => `await import(${JSON.stringify(pathToFileURL(join(root, `dist/${name}.js`)).href)})`;
    writeFileSync(script, identityBody(load).replace('new pp.PaypalWebhookVerifier !== undefined', 'typeof pp.PaypalWebhookVerifier'));
    const out = JSON.parse(runNode([script]));
    expect(out.capability).toBe(true);
  });

  const cjsGuard = (entry: string) => `
    const Module = require('node:module');
    const blocked = ${blockedSpecifier.toString()};
    const original = Module._resolveFilename;
    const seen = [];
    Module._resolveFilename = function (request, ...rest) {
      if (blocked.test(request)) seen.push(request);
      return original.call(this, request, ...rest);
    };
    require(${JSON.stringify(join(root, `dist/${entry}.cjs`))});
    const cached = Object.keys(require.cache).filter((k) => /node_modules[\\\\/](axios|zod|express|@idevconn[\\\\/]payment[\\\\/])/.test(k));
    console.log(JSON.stringify({ seen, cached }));
  `;

  it.each(['index', 'paypal', 'subscription', 'testing'])('loads dist/%s.cjs without axios, zod, express or @idevconn/payment', (entry) => {
    const out = JSON.parse(runNode(['-e', cjsGuard(entry)]));
    expect(out).toEqual({ seen: [], cached: [] });
  });

  it('loads dist/legacy.cjs with @idevconn/payment', () => {
    const out = JSON.parse(runNode(['-e', cjsGuard('legacy')]));
    expect(out.seen).toContain('@idevconn/payment');
  });

  const hooks = join(scratch, 'hooks.mjs');
  const register = join(scratch, 'register.mjs');
  const esmGuard = (entry: string) => {
    writeFileSync(
      hooks,
      `const blocked = ${blockedSpecifier.toString()};
       export async function resolve(specifier, context, next) {
         if (blocked.test(specifier)) console.log('BLOCKED:' + specifier);
         return next(specifier, context);
       }`,
    );
    writeFileSync(register, `import { register } from 'node:module';\nregister(${JSON.stringify(pathToFileURL(hooks).href)});`);
    const script = join(scratch, `guard-${entry}.mjs`);
    writeFileSync(script, `await import(${JSON.stringify(pathToFileURL(join(root, `dist/${entry}.js`)).href)});`);
    return runNode(['--import', register, script])
      .split('\n')
      .filter((line) => line.startsWith('BLOCKED:'));
  };

  it.each(['index', 'paypal', 'subscription', 'testing'])('loads dist/%s.js without axios, zod, express or @idevconn/payment', (entry) => {
    expect(esmGuard(entry)).toEqual([]);
  });

  it('loads dist/legacy.js with @idevconn/payment', () => {
    expect(esmGuard('legacy')).toContain('BLOCKED:@idevconn/payment');
  });
});
