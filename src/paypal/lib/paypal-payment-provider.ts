import {
  PaypalStrategy,
  type CaptureResult,
  type OrderResult,
  type PaymentStrategy,
} from '@idevconn/payment';
import {
  assertCapabilityReady,
  type ResolvedPaymentRuntime,
  ScopedTokenCacheRegistry,
} from '../../core/index';
import type {
  PaymentCapability,
  PaymentExecutionStatus,
  PaymentProviderDescriptor,
} from '../../contracts/index';
import { UnconfiguredFakeCheckoutStrategy } from './unconfigured-fake-checkout.strategy';

export class PaypalPaymentProvider {
  private readonly checkoutStrategies = new ScopedTokenCacheRegistry<PaymentStrategy>();

  constructor(
    private readonly runtime: ResolvedPaymentRuntime,
    private readonly executionStatus?: PaymentExecutionStatus,
  ) {}

  describe(): PaymentProviderDescriptor {
    const simulatedExecutionAvailable = this.executionStatus?.simulatedExecutionEnabled ?? false;
    const providerCallsEnabled = this.executionStatus?.providerCallsEnabled ?? false;
    const capabilities = this.runtime.descriptor.capabilities.map((row) => {
      if (simulatedExecutionAvailable) {
        return {
          ...row,
          ready: false,
          configured: row.configured ? false : row.configured,
          eligible: row.eligible === true ? ('unknown' as const) : row.eligible,
          unavailableReason:
            row.unavailableReason ??
            'PayPal capability readiness is unavailable while simulated execution is active',
        };
      }
      return row;
    });

    return {
      ...this.runtime.descriptor,
      capabilities,
      executionMode: this.executionStatus?.executionMode ?? null,
      simulatedExecutionAvailable,
      providerCallsEnabled,
    };
  }

  requireCapability(capability: PaymentCapability): void {
    assertCapabilityReady(this.runtime.descriptor.capabilities, capability);
  }

  createCheckoutStrategy(): PaymentStrategy {
    return this.checkoutStrategies.get(
      {
        accountRef: this.runtime.context.accountRef,
        environment: this.runtime.context.environment,
      },
      () => this.buildCheckoutStrategy(),
    );
  }

  hasScopedCheckoutStrategy(
    accountRef: string,
    environment: ResolvedPaymentRuntime['context']['environment'],
  ): boolean {
    return this.checkoutStrategies.has({ accountRef, environment });
  }

  private buildCheckoutStrategy(): PaymentStrategy {
    const checkout = this.runtime.descriptor.capabilities.find(
      (row) => row.capability === 'checkout',
    );
    if (this.runtime.mode === 'fake' || !checkout?.ready || !this.runtime.checkoutCredentials) {
      return new UnconfiguredFakeCheckoutStrategy(this.runtime.context.providerCode);
    }

    const credentials = this.runtime.checkoutCredentials;
    return new PaypalStrategy({
      clientId: credentials.clientId,
      secret: credentials.clientSecret,
      environment: credentials.environment,
      requestTimeoutMs: credentials.requestTimeoutMs,
    });
  }
}

export type CheckoutOperation = 'createOrder' | 'captureOrder';

export async function invokeCheckoutWhenReady(
  provider: PaypalPaymentProvider,
  operation: CheckoutOperation,
  run: (strategy: PaymentStrategy) => Promise<OrderResult | CaptureResult>,
): Promise<OrderResult | CaptureResult> {
  provider.requireCapability('checkout');
  const strategy = provider.createCheckoutStrategy();
  return run(strategy);
}
