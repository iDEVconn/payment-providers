import { describe, expect, it } from 'vitest';

describe('package import side effects', () => {
  it('importing root and paypal entrypoints does not throw without application env', async () => {
    await expect(import('../src/index')).resolves.toBeDefined();
    await expect(import('../src/paypal/index')).resolves.toBeDefined();
  });
});
