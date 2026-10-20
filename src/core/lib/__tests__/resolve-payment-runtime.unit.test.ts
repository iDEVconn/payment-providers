import { describe, expect, it } from 'vitest';
import { PaymentConfigurationError } from '../payment-configuration-error';
import { resolvePaymentRuntime } from '../resolve-payment-runtime';
import type { PaymentProviderConfig } from '../payment-provider-config';

describe('resolvePaymentRuntime', () => {
  it('requires applicationRef on provider config', () => {
    expect(() =>
      resolvePaymentRuntime({
        config: { environment: 'sandbox', applicationRef: '' },
      }),
    ).toThrow(PaymentConfigurationError);
  });

  it('returns fake mode with a banner when checkout credentials are missing in development', () => {
    const config: PaymentProviderConfig = { environment: 'sandbox', applicationRef: 'test-app' };
    const runtime = resolvePaymentRuntime({
      config,
      nodeEnv: 'development',
    });
    expect(runtime.mode).toBe('fake');
    expect(runtime.configBanner).toContain('credentials.clientId');
    expect(runtime.configBanner).toContain('credentials.clientSecret');
    expect(runtime.configBanner).not.toContain('apps/microservices');
    const refund = runtime.descriptor.capabilities.find((row) => row.capability === 'refund');
    expect(refund?.ready).toBe(false);
  });

  it('starts in production with missing credentials using reject mode and a banner', () => {
    const runtime = resolvePaymentRuntime({
      config: { environment: 'sandbox', applicationRef: 'test-app' },
      nodeEnv: 'production',
      executionStatus: {
        executionMode: 'sandbox',
        deploymentEnvironment: 'staging',
        runtimeState: 'configured',
        providerCallsEnabled: true,
        simulatedExecutionEnabled: false,
        source: 'provider-environment',
        issues: [],
      },
    });
    expect(runtime.mode).toBe('fake');
    expect(runtime.configBanner).toContain('credentials.clientId');
    expect(runtime.descriptor.capabilities.find((c) => c.capability === 'checkout')?.ready).toBe(
      false,
    );
  });

  it('returns live-provider mode when checkout credentials exist', () => {
    const runtime = resolvePaymentRuntime({
      config: {
        environment: 'sandbox',
        applicationRef: 'test-app',
        credentials: { clientId: 'id', clientSecret: 'secret' },
      },
      nodeEnv: 'development',
      executionStatus: {
        executionMode: 'sandbox',
        deploymentEnvironment: 'local',
        runtimeState: 'configured',
        providerCallsEnabled: true,
        simulatedExecutionEnabled: false,
        source: 'provider-environment',
        issues: [],
      },
    });
    expect(runtime.mode).toBe('live-provider');
    expect(runtime.checkoutCredentials).toEqual({
      clientId: 'id',
      clientSecret: 'secret',
      environment: 'sandbox',
    });
  });

  it('scopes descriptors by accountRef and environment', () => {
    const sandbox = resolvePaymentRuntime({
      config: {
        environment: 'sandbox',
        applicationRef: 'test-app',
        accountRef: 'acct-a',
        credentials: { clientId: 'id', clientSecret: 'secret' },
      },
      nodeEnv: 'development',
      executionStatus: {
        executionMode: 'sandbox',
        deploymentEnvironment: 'local',
        runtimeState: 'configured',
        providerCallsEnabled: true,
        simulatedExecutionEnabled: false,
        source: 'provider-environment',
        issues: [],
      },
    });
    const live = resolvePaymentRuntime({
      config: {
        environment: 'live',
        applicationRef: 'test-app',
        accountRef: 'acct-b',
        credentials: { clientId: 'id-live', clientSecret: 'secret-live' },
      },
      nodeEnv: 'development',
      executionStatus: {
        executionMode: 'live',
        deploymentEnvironment: 'local',
        runtimeState: 'configured',
        providerCallsEnabled: true,
        simulatedExecutionEnabled: false,
        source: 'provider-environment',
        issues: [],
      },
    });

    expect(sandbox.descriptor.accountRef).toBe('acct-a');
    expect(sandbox.descriptor.environment).toBe('sandbox');
    expect(live.descriptor.accountRef).toBe('acct-b');
    expect(live.descriptor.environment).toBe('live');
  });
});
