import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('PayPal checkout executor route blindness', () => {
  it('does not import or hardcode application client routes', () => {
    const root = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(root, '../paypal-checkout-executor.ts'), 'utf8');
    expect(source).not.toContain('/wallet');
    expect(source).not.toContain('/discover');
    expect(source).not.toContain('/advertiser-accounts');
    expect(source).not.toContain('marketplace');
  });
});
