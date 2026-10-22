import type { PaymentExecutionStatus } from '../../contracts/index';

export function shouldBlockProviderNetwork(status?: PaymentExecutionStatus): boolean {
  if (!status) {
    return false;
  }
  return status.runtimeState !== 'configured' || !status.providerCallsEnabled;
}
