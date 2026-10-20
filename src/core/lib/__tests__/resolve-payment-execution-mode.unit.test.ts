import { describe, expect, it } from 'vitest';
import type { NormalizedDeployedPaymentConfig } from '../../../contracts/index';
import { resolvePaymentExecutionMode } from '../resolve-payment-execution-mode';

function base(
  overrides: Partial<NormalizedDeployedPaymentConfig> = {},
): NormalizedDeployedPaymentConfig {
  return {
    nodeEnv: 'development',
    providerEnvironment: null,
    providerEnvironmentInvalid: false,
    financialSimulation: false,
    legacyPaymentExecutionMode: null,
    legacyPaymentDeploymentEnvironment: null,
    legacyFundingSimulation: null,
    ...overrides,
  };
}

describe('resolvePaymentExecutionMode', () => {
  it('configures sandbox from PAYPAL_ENVIRONMENT', () => {
    const status = resolvePaymentExecutionMode(base({ providerEnvironment: 'sandbox' }));
    expect(status.runtimeState).toBe('configured');
    expect(status.executionMode).toBe('sandbox');
    expect(status.deploymentEnvironment).toBe('local');
    expect(status.providerCallsEnabled).toBe(true);
    expect(status.source).toBe('provider-environment');
  });

  it('configures live in production with staging deployment for sandbox', () => {
    const status = resolvePaymentExecutionMode(
      base({ nodeEnv: 'production', providerEnvironment: 'live' }),
    );
    expect(status.runtimeState).toBe('configured');
    expect(status.executionMode).toBe('live');
    expect(status.deploymentEnvironment).toBe('live');
  });

  it('forbids missing provider environment', () => {
    const status = resolvePaymentExecutionMode(base());
    expect(status.runtimeState).toBe('forbidden');
    expect(status.issues[0]?.code).toBe('MISSING_PROVIDER_ENVIRONMENT');
  });

  it('forbids invalid provider environment', () => {
    const status = resolvePaymentExecutionMode(
      base({ providerEnvironment: null, providerEnvironmentInvalid: true }),
    );
    expect(status.issues[0]?.code).toBe('INVALID_PROVIDER_ENVIRONMENT');
  });

  it('allows explicit test simulation outside production', () => {
    const status = resolvePaymentExecutionMode(base({ financialSimulation: true }));
    expect(status.runtimeState).toBe('configured');
    expect(status.executionMode).toBe('simulation');
    expect(status.deploymentEnvironment).toBe('ci');
    expect(status.simulatedExecutionEnabled).toBe(true);
    expect(status.source).toBe('test-simulation');
  });

  it('forbids test simulation in production', () => {
    const status = resolvePaymentExecutionMode(
      base({ nodeEnv: 'production', financialSimulation: true }),
    );
    expect(status.runtimeState).toBe('forbidden');
    expect(status.issues[0]?.code).toBe('SIMULATION_FORBIDDEN_IN_PRODUCTION');
  });

  it('reports legacy alias conflict when PAYMENT_EXECUTION_MODE=simulation is set', () => {
    const status = resolvePaymentExecutionMode(
      base({
        providerEnvironment: 'sandbox',
        legacyPaymentExecutionMode: 'simulation',
      }),
    );
    expect(status.runtimeState).toBe('conflict');
    expect(status.issues.some((i) => i.code === 'LEGACY_ALIAS_CONFLICT')).toBe(true);
  });

  it('reports mismatch when legacy mode disagrees with PAYPAL_ENVIRONMENT', () => {
    const status = resolvePaymentExecutionMode(
      base({
        providerEnvironment: 'sandbox',
        legacyPaymentExecutionMode: 'live',
      }),
    );
    expect(status.runtimeState).toBe('conflict');
    expect(status.issues.some((i) => i.code === 'PAYPAL_ENVIRONMENT_MISMATCH')).toBe(true);
  });

  it('reports legacy conflict when FUNDING_SIMULATION is set', () => {
    const status = resolvePaymentExecutionMode(
      base({
        providerEnvironment: 'sandbox',
        legacyFundingSimulation: 'true',
      }),
    );
    expect(status.runtimeState).toBe('conflict');
    expect(status.issues.some((i) => i.code === 'LEGACY_ALIAS_CONFLICT')).toBe(true);
  });

  it('reports legacy conflict for test simulation when FUNDING_SIMULATION is set', () => {
    const status = resolvePaymentExecutionMode(
      base({ financialSimulation: true, legacyFundingSimulation: 'true' }),
    );
    expect(status.runtimeState).toBe('conflict');
    expect(status.issues.some((i) => i.code === 'LEGACY_ALIAS_CONFLICT')).toBe(true);
  });
});
