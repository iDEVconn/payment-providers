import { describe, expect, it } from 'vitest';
import { PaymentConfigurationError } from '../payment-configuration-error';
import { resolvePaymentRuntime } from '../resolve-payment-runtime';
import type { PaymentProviderConfig } from '../payment-provider-config';
import type { PaymentExecutionStatus } from '../../../contracts/index';

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

  it('throws in production when credentials are missing (no reject-only boot)', () => {
    const error = captureError(() =>
      resolvePaymentRuntime({
        config: { environment: 'sandbox', applicationRef: 'test-app' },
        nodeEnv: 'production',
        executionStatus: configuredStatus,
      }),
    );
    expect(error).toBeInstanceOf(PaymentConfigurationError);
    expect((error as PaymentConfigurationError).missingFields).toEqual([
      'credentials.clientId',
      'credentials.clientSecret',
    ]);
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

const configuredStatus: PaymentExecutionStatus = {
  executionMode: 'live',
  deploymentEnvironment: 'live',
  runtimeState: 'configured',
  providerCallsEnabled: true,
  simulatedExecutionEnabled: false,
  source: 'provider-environment',
  issues: [],
};

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('resolvePaymentRuntime in production (#7)', () => {
  const credentials = { clientId: 'client-id-value', clientSecret: 'client-secret-value' };

  it('throws when no credentials and no executionStatus are given', () => {
    const error = captureError(() =>
      resolvePaymentRuntime({
        config: { environment: 'live', applicationRef: 'app' },
        nodeEnv: 'production',
      }),
    );
    expect(error).toBeInstanceOf(PaymentConfigurationError);
    expect((error as PaymentConfigurationError).missingFields).toEqual(
      expect.arrayContaining(['credentials.clientId', 'credentials.clientSecret', 'executionStatus']),
    );
  });

  it('throws when credentials are absent even if checkout is disabled and executionStatus is missing', () => {
    expect(() =>
      resolvePaymentRuntime({
        config: { environment: 'live', applicationRef: 'app', capabilityFlags: { checkout: false } },
        nodeEnv: 'production',
      }),
    ).toThrow(PaymentConfigurationError);
  });

  it('throws when executionStatus is unconfigured', () => {
    const error = captureError(() =>
      resolvePaymentRuntime({
        config: { environment: 'live', applicationRef: 'app', credentials },
        nodeEnv: 'production',
        executionStatus: {
          runtimeState: 'unconfigured',
          deploymentEnvironment: 'live',
          executionMode: null,
          providerCallsEnabled: false,
          simulatedExecutionEnabled: false,
          source: 'unconfigured',
          issues: [{ code: 'PAYMENT_PROVIDER_ENVIRONMENT_MISSING' } as never],
        },
      }),
    );
    expect(error).toBeInstanceOf(PaymentConfigurationError);
    expect((error as PaymentConfigurationError).missingFields).toEqual(
      expect.arrayContaining(['executionStatus.runtimeState']),
    );
    expect(String((error as Error).message)).not.toContain('client-secret-value');
  });

  it('throws when executionStatus disables provider calls (simulation)', () => {
    expect(() =>
      resolvePaymentRuntime({
        config: { environment: 'live', applicationRef: 'app', credentials },
        nodeEnv: 'production',
        executionStatus: {
          ...configuredStatus,
          executionMode: 'simulation',
          providerCallsEnabled: false,
          simulatedExecutionEnabled: true,
        },
      }),
    ).toThrow(PaymentConfigurationError);
  });

  it('throws a PaymentConfigurationError for forbidden and conflict states', () => {
    for (const runtimeState of ['forbidden', 'conflict'] as const) {
      expect(() =>
        resolvePaymentRuntime({
          config: { environment: 'live', applicationRef: 'app', credentials },
          nodeEnv: 'production',
          executionStatus: { ...configuredStatus, runtimeState, providerCallsEnabled: false },
        }),
      ).toThrow(PaymentConfigurationError);
    }
  });

  it('never prints credential values in the thrown message', () => {
    const error = captureError(() =>
      resolvePaymentRuntime({
        config: {
          environment: 'live',
          applicationRef: 'app',
          credentials: { clientId: 'client-id-value', clientSecret: '' },
        },
        nodeEnv: 'production',
      }),
    );
    expect((error as PaymentConfigurationError).missingFields).toEqual(
      expect.arrayContaining(['credentials.clientSecret']),
    );
    expect((error as PaymentConfigurationError).missingFields).not.toContain(
      'credentials.clientId',
    );
    expect(String((error as Error).message)).not.toContain('client-id-value');
  });

  it('returns live-provider with credentials and without executionStatus', () => {
    const runtime = resolvePaymentRuntime({
      config: { environment: 'live', applicationRef: 'app', credentials },
      nodeEnv: 'production',
    });
    expect(runtime.mode).toBe('live-provider');
  });

  it('keeps the non-production behaviour (fake runtime with a banner)', () => {
    for (const nodeEnv of [undefined, 'development', 'test', 'prod']) {
      const runtime = resolvePaymentRuntime({
        config: { environment: 'live', applicationRef: 'app' },
        nodeEnv,
      });
      expect(runtime.mode).toBe('fake');
      expect(runtime.configBanner).toContain('credentials.clientId');
    }
  });

  it('allows the kill switch (configured, provider calls off) and returns a reject-only runtime', () => {
    const runtime = resolvePaymentRuntime({
      config: { environment: 'live', applicationRef: 'app', credentials },
      nodeEnv: 'production',
      executionStatus: { ...configuredStatus, providerCallsEnabled: false },
    });
    expect(runtime.mode).toBe('fake');
  });

  it('allowRejectOnlyInProduction keeps the reject-only runtime for intentional payments-off deployments', () => {
    const noCredentials = resolvePaymentRuntime({
      config: { environment: 'live', applicationRef: 'app' },
      nodeEnv: 'production',
      allowRejectOnlyInProduction: true,
    });
    expect(noCredentials.mode).toBe('fake');
    expect(noCredentials.configBanner).toContain('credentials.clientId');
    const unconfigured = resolvePaymentRuntime({
      config: { environment: 'live', applicationRef: 'app', credentials },
      nodeEnv: 'production',
      executionStatus: { ...configuredStatus, runtimeState: 'unconfigured', providerCallsEnabled: false },
      allowRejectOnlyInProduction: true,
    });
    expect(unconfigured.mode).toBe('fake');
  });

  it('allowRejectOnlyInProduction does not hide forbidden or conflicting execution modes', () => {
    expect(() =>
      resolvePaymentRuntime({
        config: { environment: 'live', applicationRef: 'app', credentials },
        nodeEnv: 'production',
        executionStatus: { ...configuredStatus, runtimeState: 'conflict', providerCallsEnabled: false },
        allowRejectOnlyInProduction: true,
      }),
    ).toThrow(PaymentConfigurationError);
  });
});
