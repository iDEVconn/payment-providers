import { describe, expect, it } from 'vitest';
import { EXECUTION_MODE_MISMATCH } from '../../../contracts/index';
import {
  assertExecutionContextMatchesLocal,
  PaymentExecutionModeError,
} from '../payment-execution-context';

const localConfigured = {
  executionMode: 'simulation' as const,
  deploymentEnvironment: 'local' as const,
  runtimeState: 'configured' as const,
  providerCallsEnabled: false,
  simulatedExecutionEnabled: true,
  source: 'explicit' as const,
  issues: [],
};

describe('assertExecutionContextMatchesLocal', () => {
  it('accepts matching gateway stamp', () => {
    expect(() =>
      assertExecutionContextMatchesLocal(localConfigured, {
        executionMode: 'simulation',
        deploymentEnvironment: 'local',
        applicationRef: 'edc',
      }),
    ).not.toThrow();
  });

  it('rejects mismatch before provider execution', () => {
    expect(() =>
      assertExecutionContextMatchesLocal(localConfigured, {
        executionMode: 'sandbox',
        deploymentEnvironment: 'local',
        applicationRef: 'edc',
      }),
    ).toThrowError(PaymentExecutionModeError);

    try {
      assertExecutionContextMatchesLocal(localConfigured, {
        executionMode: 'sandbox',
        deploymentEnvironment: 'local',
        applicationRef: 'edc',
      });
    } catch (error) {
      expect((error as PaymentExecutionModeError).code).toBe(EXECUTION_MODE_MISMATCH);
    }
  });

  it('allows missing stamp for transitional unstamped callers', () => {
    expect(() => assertExecutionContextMatchesLocal(localConfigured, undefined)).not.toThrow();
  });
});
