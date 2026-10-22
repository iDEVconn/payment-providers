import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Pins the names a consumer sees in the built declarations (types and values) per entry point, so a
// type that leaks through an `export *` also fails. Runtime names are pinned in
// public-exports.unit.test.ts; both use test/fixtures/export-surface/*.json.
const root = join(import.meta.dirname, '..');
const fixtureDir = join(import.meta.dirname, 'fixtures/export-surface');
const distReady = existsSync(join(root, 'dist/index.d.ts'));

type SurfaceFixture = { runtime: string[]; typeOnly: string[] };

function declaredNames(dtsFile: string): string[] {
  const program = ts.createProgram([dtsFile], {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    skipLibCheck: true,
    noEmit: true,
    types: [],
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(dtsFile);
  const moduleSymbol = source ? checker.getSymbolAtLocation(source) : undefined;
  if (!moduleSymbol) {
    throw new Error(`no module symbol for ${dtsFile}`);
  }
  return checker
    .getExportsOfModule(moduleSymbol)
    .map((symbol) => symbol.name)
    .filter((name) => name !== 'default')
    .sort();
}

describe.skipIf(!distReady)('built declaration export surface', () => {
  const entries = [
    'root:index',
    'paypal:paypal',
    'subscription:subscription',
    'testing:testing',
    'legacy:legacy',
  ];

  for (const entry of entries) {
    const [name, file] = entry.split(':') as [string, string];
    it(`${name} declarations export exactly the pinned names`, () => {
      const fixturePath = join(fixtureDir, `${name}.json`);
      const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as SurfaceFixture;
      const actual = declaredNames(join(root, `dist/${file}.d.ts`));
      if (process.env.UPDATE_EXPORT_SURFACE === '1') {
        const runtime = new Set(fixture.runtime);
        const typeOnly = actual.filter((exported) => !runtime.has(exported));
        const updated = { runtime: fixture.runtime, typeOnly };
        writeFileSync(fixturePath, `${JSON.stringify(updated, null, 2)}\n`);
        return;
      }
      expect(actual).toEqual([...fixture.runtime, ...fixture.typeOnly].sort());
    });
  }
});
