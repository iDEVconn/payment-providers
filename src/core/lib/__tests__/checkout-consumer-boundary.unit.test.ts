import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { CheckoutLifecycleService } from '../checkout-lifecycle-service';
import { MemoryPaymentReliabilityStore } from '../persistence/memory-payment-reliability-store';

function collectSourceFiles(root: string): string[] {
  const entries = readdirSync(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
      continue;
    }
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.unit.test.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('checkout consumer boundary', () => {
  it('composes checkout lifecycle from payment contracts without EDC imports', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const provider = {
      createOrder: vi.fn().mockResolvedValue({
        providerOrderId: 'order-1',
        checkoutStatus: 'created',
        approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=order-1',
        amount: { currency: 'USD', amountMinor: '10700' },
      }),
      getOrder: vi.fn(),
      captureOrder: vi.fn(),
      refundCapture: vi.fn(),
      getRefund: vi.fn(),
    };
    const service = new CheckoutLifecycleService(store, provider);
    const result = await service.createCheckoutOrder({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'other-app',
      environment: 'sandbox',
      idempotencyKey: 'checkout-1',
      amount: { currency: 'USD', amountMinor: '10700' },
    });
    expect(result.approvalUrl).toContain('sandbox.paypal.com');
    expect(result.checkoutStatus).toBe('created');
  });

  it('keeps core and contracts free of gateway and application-domain imports', () => {
    const moduleRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const roots = [
      join(moduleRoot, 'core'),
      join(moduleRoot, 'contracts'),
    ].filter((root) => existsSync(root));
    for (const root of roots) {
      for (const file of collectSourceFiles(root)) {
        const source = readFileSync(file, 'utf8');
        expect(source).not.toMatch(/apps\/api/);
        expect(source).not.toMatch(/apps\/api\/src\/app\/edc/);
        expect(source).not.toMatch(/@icore\/edc-application-contracts/);
        expect(source).not.toMatch(/@idevcon\/edc-api-contracts/);
      }
    }
  });
});
