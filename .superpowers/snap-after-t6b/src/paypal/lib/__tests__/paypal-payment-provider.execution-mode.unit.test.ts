import { describe, expect, it } from 'vitest';
import { resolvePaymentRuntime } from '../../../core/index';
import { sandboxPaypalProviderConfig } from '../../../../test/helpers/provider-config-fixtures';
import { PaypalPaymentProvider } from '../paypal-payment-provider';

describe('PaypalPaymentProvider execution mode readiness', () => {
  it('does not report PayPal capabilities ready during simulation', () => {
    const runtime = resolvePaymentRuntime({
      config: sandboxPaypalProviderConfig({
        credentials: { clientId: 'set', clientSecret: 'set' },
      }),
      nodeEnv: 'development',
      executionStatus: {
        executionMode: 'simulation',
        deploymentEnvironment: 'local',
        runtimeState: 'configured',
        providerCallsEnabled: false,
        simulatedExecutionEnabled: true,
        source: 'explicit',
        issues: [],
      },
    });
    const provider = new PaypalPaymentProvider(runtime, {
      executionMode: 'simulation',
      deploymentEnvironment: 'local',
      runtimeState: 'configured',
      providerCallsEnabled: false,
      simulatedExecutionEnabled: true,
      source: 'explicit',
      issues: [],
    });

    const descriptor = provider.describe();
    expect(descriptor.simulatedExecutionAvailable).toBe(true);
    expect(descriptor.providerCallsEnabled).toBe(false);
    expect(descriptor.executionMode).toBe('simulation');
    expect(descriptor.capabilities.every((row) => row.ready === false)).toBe(true);
    expect(descriptor.capabilities.every((row) => row.eligible !== true)).toBe(true);
  });
});
