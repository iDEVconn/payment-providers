/**
 * One-time import rewrite after copying from EmployeeDrivenContent.
 * Only replaces known workspace aliases with relative paths.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const srcRoot = path.join(packageRoot, 'src');
const contractsIndex = path.join(srcRoot, 'contracts', 'index.ts');
const coreIndex = path.join(srcRoot, 'core', 'index.ts');
const hostEnvBanner = path.join(srcRoot, 'core', 'lib', 'host-env-banner.ts');

function relImport(fromFile, targetFile) {
  let rel = path.relative(path.dirname(fromFile), targetFile).replace(/\\/g, '/');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel.replace(/\.ts$/, '');
}

function walk(dir, files = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, files);
    else if (ent.name.endsWith('.ts')) files.push(p);
  }
  return files;
}

const replacements = [
  ['@icore/payment-contracts', contractsIndex],
  ['@icore/payment-core', coreIndex],
  ['@icore/shared', hostEnvBanner],
];

let changed = 0;
for (const file of walk(srcRoot)) {
  if (file === hostEnvBanner) continue;
  let source = fs.readFileSync(file, 'utf8');
  const before = source;
  for (const [spec, target] of replacements) {
    const rel = relImport(file, target);
    source = source.replaceAll(`'${spec}'`, `'${rel}'`);
    source = source.replaceAll(`"${spec}"`, `"${rel}"`);
  }
  if (source !== before) {
    fs.writeFileSync(file, source);
    changed += 1;
  }
}

console.log(`Rewrote imports in ${changed} files.`);
