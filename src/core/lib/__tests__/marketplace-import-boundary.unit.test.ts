import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const moduleRoot = join(__dirname, '../../../..');

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
  it.each(marketplaceSources)('keeps %s isolated from application domain modules', (relativePath) => {
    const source = readFileSync(join(moduleRoot, relativePath), 'utf8');
    for (const pattern of forbiddenImportPatterns) {
      expect(source).not.toMatch(pattern);
    }
  });
});
