import {
  EXECUTION_MODE_BLOCKED,
  EXECUTION_MODE_MISMATCH,
  type PaymentExecutionContext,
  type PaymentExecutionStatus,
} from '../../contracts/index';

export class PaymentExecutionModeError extends Error {
  readonly code: typeof EXECUTION_MODE_MISMATCH | typeof EXECUTION_MODE_BLOCKED;

  constructor(
    code: typeof EXECUTION_MODE_MISMATCH | typeof EXECUTION_MODE_BLOCKED,
    message: string,
  ) {
    super(message);
    this.name = 'PaymentExecutionModeError';
    this.code = code;
  }
}

export function assertExecutionContextMatchesLocal(
  local: PaymentExecutionStatus,
  incoming: PaymentExecutionContext | undefined,
): void {
  if (local.runtimeState !== 'configured' || !local.executionMode || !local.deploymentEnvironment) {
    throw new PaymentExecutionModeError(
      EXECUTION_MODE_BLOCKED,
      'Payment execution is not configured for provider operations',
    );
  }

  if (!incoming) {
    return;
  }

  if (
    incoming.executionMode !== local.executionMode ||
    incoming.deploymentEnvironment !== local.deploymentEnvironment
  ) {
    throw new PaymentExecutionModeError(
      EXECUTION_MODE_MISMATCH,
      'Gateway and Payment MS execution mode mismatch',
    );
  }
}

export function assertProviderNetworkPermitted(status: PaymentExecutionStatus): void {
  if (status.runtimeState !== 'configured') {
    throw new PaymentExecutionModeError(
      EXECUTION_MODE_BLOCKED,
      'Payment execution is not configured for provider network calls',
    );
  }

  if (!status.providerCallsEnabled) {
    throw new PaymentExecutionModeError(
      EXECUTION_MODE_BLOCKED,
      'Provider network calls are disabled for the resolved execution mode',
    );
  }
}

export function assertSimulatedExecutionPermitted(status: PaymentExecutionStatus): void {
  if (!status.simulatedExecutionEnabled) {
    throw new PaymentExecutionModeError(
      EXECUTION_MODE_BLOCKED,
      'Simulated financial execution is not enabled',
    );
  }
}
