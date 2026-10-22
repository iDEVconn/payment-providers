import { readFileSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { collectProductionTsFiles } from './architecture-boundary-scanner';

/*
 * The pure subscription core (`@idevconn/payment-providers/subscription`) may
 * import only its own files at runtime and `contracts` for types. It must not
 * do IO, read the clock or use randomness: time and ids come in as parameters.
 */

const srcRoot = join(import.meta.dirname, '../src');
const coreRoot = join(srcRoot, 'subscription-core');
const contractsRoot = join(srcRoot, 'contracts');

type Violation = { file: string; detail: string };

const FORBIDDEN_GLOBALS: Array<[RegExp, string]> = [
  [/\bDate\s*\.\s*now\b/, 'Date.now'],
  [/\bnew\s+Date\s*\(\s*\)/, 'new Date() without arguments'],
  [/\bMath\s*\.\s*random\b/, 'Math.random'],
  [/\bperformance\s*\.\s*now\b/, 'performance.now'],
  [/\bcrypto\s*\.\s*(randomUUID|getRandomValues|randomBytes)\b/, 'crypto randomness'],
  [/\bprocess\s*\.\s*(env|hrtime)\b/, 'process.env / process.hrtime'],
  [/\b(setTimeout|setInterval|setImmediate|queueMicrotask)\s*\(/, 'timers'],
  [/\bfetch\s*\(/, 'fetch'],
  [/\brequire\s*\(/, 'require'],
];

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
}

function scanSubscriptionCoreSource(file: string, text: string): Violation[] {
  const violations: Violation[] = [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

  const checkSpecifier = (specifier: string, typeOnly: boolean) => {
    if (!specifier.startsWith('.')) {
      violations.push({ file, detail: `imports package or builtin "${specifier}"` });
      return;
    }
    const target = resolve(dirname(file), specifier);
    if (isInside(target, coreRoot)) {
      return;
    }
    if (isInside(target, contractsRoot) && typeOnly) {
      return;
    }
    violations.push({
      file,
      detail: `${typeOnly ? 'type ' : ''}import of "${specifier}" leaves subscription-core`,
    });
  };

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const typeOnly =
        clause !== undefined &&
        (clause.isTypeOnly ||
          (clause.name === undefined &&
            clause.namedBindings !== undefined &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.length > 0 &&
            clause.namedBindings.elements.every((element) => element.isTypeOnly)));
      checkSpecifier(node.moduleSpecifier.text, typeOnly);
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      checkSpecifier(node.moduleSpecifier.text, node.isTypeOnly);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      violations.push({ file, detail: 'dynamic import' });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const [pattern, label] of FORBIDDEN_GLOBALS) {
    if (pattern.test(withoutComments)) {
      violations.push({ file, detail: `uses ${label}` });
    }
  }
  return violations;
}

describe('subscription-core purity boundary', () => {
  it('imports only itself at runtime and contracts as types; no clock, randomness or IO', () => {
    const files = collectProductionTsFiles(coreRoot);
    expect(files.length).toBeGreaterThan(0);
    const violations = files.flatMap((file) =>
      scanSubscriptionCoreSource(file, readFileSync(file, 'utf8')),
    );
    expect(violations).toEqual([]);
  });

  it('self-test: the scanner catches each forbidden pattern', () => {
    const file = join(coreRoot, 'lib/virtual.ts');
    const bad = `
      import { applySubscriptionTransition } from '../../core/lib/subscription-evidence-application';
      import { PaypalSubscriptionExecutor } from '../../paypal/index';
      import { readFileSync } from 'node:fs';
      import http from 'http';
      import { randomUUID } from 'crypto';
      import { PaymentReliabilityError } from '../../contracts/index';
      export { x } from '../../core/index';
      const t = Date.now();
      const r = Math.random();
      const d = new Date();
      const e = process.env.X;
      const m = await import('./other');
    `;
    const details = scanSubscriptionCoreSource(file, bad).map((v) => v.detail);
    expect(details).toEqual(
      expect.arrayContaining([
        'import of "../../core/lib/subscription-evidence-application" leaves subscription-core',
        'import of "../../paypal/index" leaves subscription-core',
        'imports package or builtin "node:fs"',
        'imports package or builtin "http"',
        'imports package or builtin "crypto"',
        'import of "../../contracts/index" leaves subscription-core',
        'import of "../../core/index" leaves subscription-core',
        'uses Date.now',
        'uses Math.random',
        'uses new Date() without arguments',
        'uses process.env / process.hrtime',
        'dynamic import',
      ]),
    );
  });

  it('self-test: type-only contracts imports, own files and Date.parse are allowed', () => {
    const file = join(coreRoot, 'lib/virtual.ts');
    const ok = `
      import type { SubscriptionStatus } from '../../contracts/lib/subscription';
      import { type CanonicalMoney } from '../../contracts/lib/money';
      import { parseDecimalToMinorUnits } from './subscription-money';
      export type { SubscriptionStatus };
      const ms = Date.parse('2026-10-22T10:00:00Z');
      const iso = new Date(ms).toISOString();
    `;
    expect(scanSubscriptionCoreSource(file, ok)).toEqual([]);
  });
});
