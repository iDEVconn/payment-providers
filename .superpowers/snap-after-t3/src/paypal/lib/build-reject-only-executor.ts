import type { PaymentExecutionStatus } from '../../contracts/index';
import { isProviderCallsKillSwitch, type ResolvedPaymentRuntime } from '../../core/index';
import { PaymentConfigurationError } from '../../core/lib/payment-configuration-error';
import { createBlockedHttpClient, createBlockedOAuthClient } from './blocked-provider-network';
import { shouldBlockProviderNetwork } from './provider-network-policy';

export function isExecutionModeNetworkBlocked(executionStatus?: PaymentExecutionStatus): boolean {
  return shouldBlockProviderNetwork(executionStatus);
}

export function shouldRejectProviderNetworkCalls(
  runtime: ResolvedPaymentRuntime,
  executionStatus?: PaymentExecutionStatus,
): boolean {
  return (
    isExecutionModeNetworkBlocked(executionStatus) ||
    runtime.mode === 'fake' ||
    runtime.checkoutCredentials == null
  );
}

/**
 * Production must not compose a reject-only (blocked) PayPal client: it would accept traffic and
 * fail every call. Throws a `PaymentConfigurationError` that names the settings, never their values.
 * Escape hatches: `allowRejectOnlyInProduction` (a deployment that intentionally runs without
 * payments) and, for the webhook verifier only, `allowKillSwitch` so that the documented
 * `providerCallsEnabled: false` kill switch keeps storing webhooks as pending instead of failing boot.
 */
export function assertProviderNetworkAllowedInProduction(input: {
  runtime: ResolvedPaymentRuntime;
  executionStatus?: PaymentExecutionStatus;
  nodeEnv?: string;
  component: string;
  allowRejectOnlyInProduction?: boolean;
  allowKillSwitch?: boolean;
}): void {
  const { runtime, executionStatus, nodeEnv, component } = input;
  if (
    nodeEnv !== 'production' ||
    input.allowRejectOnlyInProduction === true ||
    (input.allowKillSwitch === true && isProviderCallsKillSwitch(executionStatus)) ||
    !shouldRejectProviderNetworkCalls(runtime, executionStatus)
  ) {
    return;
  }
  const missingFields: string[] = [];
  if (executionStatus && executionStatus.runtimeState !== 'configured') {
    missingFields.push('executionStatus.runtimeState');
  }
  if (executionStatus && !executionStatus.providerCallsEnabled) {
    missingFields.push('executionStatus.providerCallsEnabled');
  }
  if (!runtime.checkoutCredentials) {
    missingFields.push('credentials.clientId', 'credentials.clientSecret');
  } else if (runtime.mode === 'fake') {
    missingFields.push('runtime.mode');
  }
  throw new PaymentConfigurationError(
    `${component} would reject every PayPal call in production (check: ${missingFields.join(', ')})`,
    missingFields,
  );
}

export function blockedOAuthGetter(): () => Promise<string> {
  return createBlockedOAuthClient();
}

export function blockedHttpClient<T>(): T {
  return createBlockedHttpClient<T>();
}
