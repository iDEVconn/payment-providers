import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

export type ArchitectureBoundaryViolation = {
  file: string;
  kind: 'import' | 'require' | 'dynamic-import' | 'literal';
  detail: string;
};

const FORBIDDEN_MODULE_SUBSTRINGS = [
  '@icore/',
  '@nestjs/',
  '@supabase/',
  '@idevcon/edc-api-contracts',
  'EmployeeDrivenContent',
  'apps/microservices/',
  'apps/api/',
];

const FORBIDDEN_LITERAL_PATTERNS = [
  /apps\/microservices\/payment\/\.env/,
  /PAYMENT_MS_ENV_PATH/,
  /\bEnvGetter\b/,
  /EmployeeDrivenContent/,
  /@icore\//,
];

export function isProductionSourcePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.includes('/__tests__/')) {
    return false;
  }
  if (normalized.endsWith('.test.ts') || normalized.endsWith('.spec.ts')) {
    return false;
  }
  if (normalized.endsWith('.unit.test.ts')) {
    return false;
  }
  return normalized.endsWith('.ts');
}

export function collectProductionTsFiles(srcRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === '__tests__') {
          continue;
        }
        walk(p);
      } else if (isProductionSourcePath(p)) {
        out.push(p);
      }
    }
  };
  walk(srcRoot);
  return out;
}

function moduleSpecifierIsForbidden(specifier: string): string | null {
  for (const fragment of FORBIDDEN_MODULE_SUBSTRINGS) {
    if (specifier.includes(fragment)) {
      return fragment;
    }
  }
  return null;
}

function scanSourceFile(filePath: string, sourceText: string): ArchitectureBoundaryViolation[] {
  const violations: ArchitectureBoundaryViolation[] = [];
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const hit = moduleSpecifierIsForbidden(node.moduleSpecifier.text);
      if (hit) {
        violations.push({
          file: filePath,
          kind: 'import',
          detail: `forbidden module "${node.moduleSpecifier.text}" (${hit})`,
        });
      }
    }

    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const hit = moduleSpecifierIsForbidden(node.moduleSpecifier.text);
      if (hit) {
        violations.push({
          file: filePath,
          kind: 'import',
          detail: `forbidden re-export "${node.moduleSpecifier.text}" (${hit})`,
        });
      }
    }

    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) {
          const hit = moduleSpecifierIsForbidden(arg.text);
          if (hit) {
            violations.push({
              file: filePath,
              kind: 'require',
              detail: `forbidden require("${arg.text}") (${hit})`,
            });
          }
        }
      }
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) {
          const hit = moduleSpecifierIsForbidden(arg.text);
          if (hit) {
            violations.push({
              file: filePath,
              kind: 'dynamic-import',
              detail: `forbidden import("${arg.text}") (${hit})`,
            });
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  for (const pattern of FORBIDDEN_LITERAL_PATTERNS) {
    if (pattern.test(sourceText)) {
      violations.push({
        file: filePath,
        kind: 'literal',
        detail: `forbidden literal pattern ${pattern}`,
      });
    }
  }

  return violations;
}

export function scanProductionTypeScriptFile(filePath: string): ArchitectureBoundaryViolation[] {
  const sourceText = readFileSync(filePath, 'utf8');
  return scanSourceFile(filePath, sourceText);
}

export function scanProductionTypeScriptSource(
  filePath: string,
  sourceText: string,
): ArchitectureBoundaryViolation[] {
  if (!isProductionSourcePath(filePath)) {
    return [];
  }
  return scanSourceFile(filePath, sourceText);
}

const FORBIDDEN_DIST_PATTERNS = [
  /@icore\//,
  /EmployeeDrivenContent/,
  /apps\/microservices\/payment\/\.env/,
  /PAYMENT_MS_ENV_PATH/,
  /\bEnvGetter\b/,
  /from ['"]@nestjs\//,
  /from ['"]@supabase\//,
  /from ['"]@idevcon\/edc-api-contracts/,
];

export function distDeclarationsAreFresh(distRoot: string, srcRoot: string): {
  fresh: boolean;
  reason?: string;
} {
  const indexDts = join(distRoot, 'index.d.ts');
  if (!existsSync(indexDts)) {
    return { fresh: false, reason: 'dist/index.d.ts is missing; run npm run build first' };
  }
  const distMtime = statSync(indexDts).mtimeMs;
  const srcFiles = collectProductionTsFiles(srcRoot);
  const newestSrcMtime = Math.max(...srcFiles.map((file) => statSync(file).mtimeMs));
  if (distMtime < newestSrcMtime) {
    return {
      fresh: false,
      reason:
        'dist declarations are older than production src; run npm run build before dist boundary checks',
    };
  }
  return { fresh: true };
}

export function scanDeclarationFile(filePath: string, sourceText: string): ArchitectureBoundaryViolation[] {
  const violations: ArchitectureBoundaryViolation[] = [];
  for (const pattern of FORBIDDEN_DIST_PATTERNS) {
    if (pattern.test(sourceText)) {
      violations.push({
        file: filePath,
        kind: 'literal',
        detail: `forbidden declaration pattern ${pattern}`,
      });
    }
  }
  return violations;
}
