import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Package-local marketplace sources (gateway service stays in the host app). */
const marketplaceSources = [
  'src/core/lib/marketplace-lifecycle-service.ts',
  'src/core/lib/marketplace-seller-precondition.ts',
  'src/core/lib/marketplace-evidence-application.ts',
  'src/core/lib/marketplace-transition-policy.ts',
  'src/contracts/lib/marketplace.ts',
  'src/paypal/lib/paypal-marketplace-executor.ts',
];

const forbiddenImportPatterns = [
  /from ['"].*edc/i,
  /from ['"].*funding/i,
  /from ['"].*settlement/i,
  /from ['"].*wallet/i,
  /from ['"].*campaign/i,
  /\b0\.07\b/,
  /\bEDC_FEE\b/,
];

describe('marketplace import boundary', () => {
  it.each(marketplaceSources)('keeps %s isolated from EDC funding modules', (relativePath) => {
    const absolutePath = join(packageRoot, relativePath);
    expect(existsSync(absolutePath), `missing ${relativePath}`).toBe(true);
    const source = readFileSync(absolutePath, 'utf8');
    for (const pattern of forbiddenImportPatterns) {
      expect(source).not.toMatch(pattern);
    }
  });
});
