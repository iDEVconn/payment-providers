import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectProductionTsFiles,
  distDeclarationsAreFresh,
  isProductionSourcePath,
  scanDeclarationFile,
  scanProductionTypeScriptFile,
  scanProductionTypeScriptSource,
} from './architecture-boundary-scanner';

const srcRoot = join(import.meta.dirname, '../src');

describe('architecture import boundary', () => {
  it('src tree does not import EDC workspace or application infrastructure', () => {
    const files = collectProductionTsFiles(srcRoot);
    expect(files.length).toBeGreaterThan(0);
    const violations = files.flatMap((file) => scanProductionTypeScriptFile(file));
    expect(violations).toEqual([]);
  });

  it('dist declaration files do not embed forbidden paths when built', () => {
    const distRoot = join(import.meta.dirname, '../dist');
    expect(existsSync(distRoot), 'dist output is missing; run npm run build first').toBe(true);
    const freshness = distDeclarationsAreFresh(distRoot, srcRoot);
    expect(freshness.fresh, freshness.reason).toBe(true);
    const distFiles: string[] = [];
    for (const ent of readdirSync(distRoot, { withFileTypes: true })) {
      if (ent.isFile() && ent.name.endsWith('.d.ts')) {
        distFiles.push(join(distRoot, ent.name));
      }
    }
    const violations = distFiles.flatMap((file) =>
      scanDeclarationFile(file, readFileSync(file, 'utf8')),
    );
    expect(violations).toEqual([]);
  });
});

describe('architecture boundary scanner (self-test)', () => {
  it('detects forbidden production import, re-export, and dynamic import', () => {
    const violations = scanProductionTypeScriptSource(
      '/virtual/production/bad.ts',
      `
        import { x } from '@icore/payment-core';
        export { y } from '@nestjs/common';
        const load = () => import('EmployeeDrivenContent/apps/api/foo');
        require('@supabase/supabase-js');
      `,
    );
    expect(violations.some((v) => v.kind === 'import' && v.detail.includes('@icore/'))).toBe(true);
    expect(violations.some((v) => v.detail.includes('re-export'))).toBe(true);
    expect(violations.some((v) => v.kind === 'dynamic-import')).toBe(true);
    expect(violations.some((v) => v.kind === 'require')).toBe(true);
  });

  it('does not scan test-only paths', () => {
    expect(isProductionSourcePath('/src/core/lib/__tests__/foo.unit.test.ts')).toBe(false);
    expect(isProductionSourcePath('/src/core/lib/foo.ts')).toBe(true);
    const testFixture = scanProductionTypeScriptSource(
      '/virtual/__tests__/fixture.unit.test.ts',
      `import { x } from '@icore/payment-core';`,
    );
    expect(testFixture).toEqual([]);
  });

  it('does not skip legitimate production files that mention test in comments', () => {
    const violations = scanProductionTypeScriptSource(
      '/virtual/production/ok.ts',
      `
        /** unit test harness comment only */
        export function ok() {
          return 1;
        }
      `,
    );
    expect(violations).toEqual([]);
  });
});
