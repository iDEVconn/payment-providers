import { describe, expect, it } from 'vitest';
import { resolvePaymentExecutionMode } from '../resolve-payment-execution-mode';

describe('resolvePaymentExecutionMode', () => {
  it('allows simulation on local', () => {
    const status = resolvePaymentExecutionMode({
      paymentExecutionMode: 'simulation',
      paymentDeploymentEnvironment: 'local',
    });
    expect(status.runtimeState).toBe('configured');
    expect(status.executionMode).toBe('simulation');
    expect(status.simulatedExecutionEnabled).toBe(true);
    expect(status.providerCallsEnabled).toBe(false);
  });

  it('forbids live on local', () => {
    const status = resolvePaymentExecutionMode({
      paymentExecutionMode: 'live',
      paymentDeploymentEnvironment: 'local',
    });
    expect(status.runtimeState).toBe('forbidden');
    expect(status.issues[0]?.code).toBe('DEPLOYMENT_MODE_FORBIDDEN');
  });

  it('allows only simulation on ci', () => {
    expect(
      resolvePaymentExecutionMode({
        paymentExecutionMode: 'simulation',
        paymentDeploymentEnvironment: 'ci',
      }).runtimeState,
    ).toBe('configured');
    expect(
      resolvePaymentExecutionMode({
        paymentExecutionMode: 'sandbox',
        paymentDeploymentEnvironment: 'ci',
      }).runtimeState,
    ).toBe('forbidden');
  });

  it('allows only live on live deployment', () => {
    const status = resolvePaymentExecutionMode({
      paymentExecutionMode: 'live',
      paymentDeploymentEnvironment: 'live',
    });
    expect(status.runtimeState).toBe('configured');
    expect(status.providerCallsEnabled).toBe(true);
  });

  it('fails closed when only the legacy alias is present', () => {
    const status = resolvePaymentExecutionMode({
      fundingSimulation: 'true',
      paymentDeploymentEnvironment: 'local',
    });
    expect(status.runtimeState).toBe('unconfigured');
    expect(status.source).toBe('unconfigured');
    expect(status.executionMode).toBe(null);
    expect(status.issues[0]?.code).toBe('MISSING_EXECUTION_MODE');
  });

  it('ignores leftover legacy alias when explicit mode is set', () => {
    const sandbox = resolvePaymentExecutionMode({
      paymentExecutionMode: 'sandbox',
      paymentDeploymentEnvironment: 'local',
      fundingSimulation: 'true',
    });
    expect(sandbox.runtimeState).toBe('configured');
    expect(sandbox.executionMode).toBe('sandbox');
    expect(sandbox.issues).toEqual([]);

    const simulation = resolvePaymentExecutionMode({
      paymentExecutionMode: 'simulation',
      paymentDeploymentEnvironment: 'local',
      fundingSimulation: 'true',
    });
    expect(simulation.runtimeState).toBe('configured');
    expect(simulation.executionMode).toBe('simulation');
    expect(simulation.simulatedExecutionEnabled).toBe(true);
    expect(simulation.issues).toEqual([]);
  });

  it('does not treat alias false as overriding explicit mode', () => {
    const status = resolvePaymentExecutionMode({
      paymentExecutionMode: 'simulation',
      paymentDeploymentEnvironment: 'local',
      fundingSimulation: 'false',
    });
    expect(status.runtimeState).toBe('configured');
    expect(status.executionMode).toBe('simulation');
  });

  it('returns unconfigured when mode and alias are absent', () => {
    const status = resolvePaymentExecutionMode({
      paymentDeploymentEnvironment: 'local',
    });
    expect(status.runtimeState).toBe('unconfigured');
    expect(status.source).toBe('unconfigured');
    expect(status.issues[0]?.code).toBe('MISSING_EXECUTION_MODE');
  });

  it('ignores credentials for mode selection', () => {
    const status = resolvePaymentExecutionMode({
      paymentDeploymentEnvironment: 'local',
      paymentExecutionMode: 'simulation',
      fundingSimulation: undefined,
    });
    expect(status.executionMode).toBe('simulation');
  });

  it('fails closed on invalid deployment and mode strings', () => {
    expect(
      resolvePaymentExecutionMode({
        paymentDeploymentEnvironment: 'prod',
        paymentExecutionMode: 'simulation',
      }).runtimeState,
    ).toBe('forbidden');
    expect(
      resolvePaymentExecutionMode({
        paymentDeploymentEnvironment: 'local',
        paymentExecutionMode: 'fake',
      }).runtimeState,
    ).toBe('conflict');
  });
});
