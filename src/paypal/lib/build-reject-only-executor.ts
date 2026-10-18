import type { PaymentExecutionStatus } from '../../contracts/index';
import { createBlockedHttpClient, createBlockedOAuthClient } from './blocked-provider-network';
import { shouldBlockProviderNetwork } from './provider-network-policy';

export function isExecutionModeNetworkBlocked(executionStatus?: PaymentExecutionStatus): boolean {
  return shouldBlockProviderNetwork(executionStatus);
}

export function blockedOAuthGetter(): () => Promise<string> {
  return createBlockedOAuthClient();
}

export function blockedHttpClient<T>(): T {
  return createBlockedHttpClient<T>();
}
