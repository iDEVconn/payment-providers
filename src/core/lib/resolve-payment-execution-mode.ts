import type {
  PaymentDeploymentEnvironment,
  PaymentExecutionIssue,
  PaymentExecutionMode,
  PaymentExecutionModeSource,
  PaymentExecutionStatus,
  PaymentRuntimeState,
} from '../../contracts/index';

export const PAYMENT_EXECUTION_MODE_ENV = 'PAYMENT_EXECUTION_MODE';
export const PAYMENT_DEPLOYMENT_ENVIRONMENT_ENV = 'PAYMENT_DEPLOYMENT_ENVIRONMENT';
export const FUNDING_SIMULATION_ENV = 'FUNDING_SIMULATION';

const ALLOWED_MODES: Readonly<
  Record<PaymentDeploymentEnvironment, readonly PaymentExecutionMode[]>
> = {
  local: ['simulation', 'sandbox'],
  ci: ['simulation'],
  staging: ['simulation', 'sandbox'],
  live: ['live'],
};

const DEPLOYMENTS: readonly PaymentDeploymentEnvironment[] = [
  'local',
  'ci',
  'staging',
  'live',
] as const;

const MODES: readonly PaymentExecutionMode[] = ['simulation', 'sandbox', 'live'] as const;

export type ResolvePaymentExecutionModeInput = {
  paymentExecutionMode?: string | null;
  paymentDeploymentEnvironment?: string | null;
  fundingSimulation?: string | null;
};

function issue(code: PaymentExecutionIssue['code']): PaymentExecutionIssue {
  return { code };
}

function normalize(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

function parseDeployment(
  raw: string | null | undefined,
): PaymentDeploymentEnvironment | null | 'invalid' {
  const normalized = normalize(raw);
  if (!normalized) {
    return null;
  }
  return (DEPLOYMENTS as readonly string[]).includes(normalized)
    ? (normalized as PaymentDeploymentEnvironment)
    : 'invalid';
}

function parseMode(raw: string | null | undefined): PaymentExecutionMode | null | 'invalid' {
  const normalized = normalize(raw);
  if (!normalized) {
    return null;
  }
  return (MODES as readonly string[]).includes(normalized)
    ? (normalized as PaymentExecutionMode)
    : 'invalid';
}

function buildStatus(input: {
  executionMode: PaymentExecutionMode | null;
  deploymentEnvironment: PaymentDeploymentEnvironment | null;
  runtimeState: PaymentRuntimeState;
  source: PaymentExecutionModeSource;
  issues: PaymentExecutionIssue[];
}): PaymentExecutionStatus {
  const simulatedExecutionEnabled =
    input.runtimeState === 'configured' && input.executionMode === 'simulation';
  const providerCallsEnabled =
    input.runtimeState === 'configured' &&
    (input.executionMode === 'sandbox' || input.executionMode === 'live');

  return {
    executionMode: input.executionMode,
    deploymentEnvironment: input.deploymentEnvironment,
    runtimeState: input.runtimeState,
    providerCallsEnabled,
    simulatedExecutionEnabled,
    source: input.source,
    issues: input.issues,
  };
}

export function resolvePaymentExecutionMode(
  input: ResolvePaymentExecutionModeInput,
): PaymentExecutionStatus {
  const issues: PaymentExecutionIssue[] = [];
  const deployment = parseDeployment(input.paymentDeploymentEnvironment);
  const explicitMode = parseMode(input.paymentExecutionMode);

  if (deployment === 'invalid') {
    issues.push(issue('INVALID_DEPLOYMENT_ENVIRONMENT'));
    return buildStatus({
      executionMode: explicitMode === 'invalid' ? null : explicitMode,
      deploymentEnvironment: null,
      runtimeState: 'forbidden',
      source: 'unconfigured',
      issues,
    });
  }

  if (deployment === null) {
    issues.push(issue('MISSING_DEPLOYMENT_ENVIRONMENT'));
    return buildStatus({
      executionMode: explicitMode === 'invalid' ? null : explicitMode,
      deploymentEnvironment: null,
      runtimeState: 'forbidden',
      source: 'unconfigured',
      issues,
    });
  }

  if (explicitMode === 'invalid') {
    issues.push(issue('INVALID_EXECUTION_MODE'));
    return buildStatus({
      executionMode: null,
      deploymentEnvironment: deployment,
      runtimeState: 'conflict',
      source: 'unconfigured',
      issues,
    });
  }

  if (explicitMode !== null) {
    const allowed = ALLOWED_MODES[deployment];
    if (!allowed.includes(explicitMode)) {
      issues.push(issue('DEPLOYMENT_MODE_FORBIDDEN'));
      return buildStatus({
        executionMode: explicitMode,
        deploymentEnvironment: deployment,
        runtimeState: 'forbidden',
        source: 'explicit',
        issues,
      });
    }

    return buildStatus({
      executionMode: explicitMode,
      deploymentEnvironment: deployment,
      runtimeState: 'configured',
      source: 'explicit',
      issues,
    });
  }

  issues.push(issue('MISSING_EXECUTION_MODE'));
  return buildStatus({
    executionMode: null,
    deploymentEnvironment: deployment,
    runtimeState: 'unconfigured',
    source: 'unconfigured',
    issues,
  });
}

export function executionStatusDisplayLabel(status: PaymentExecutionStatus): string {
  if (status.runtimeState === 'conflict') {
    return 'conflict';
  }
  if (status.runtimeState === 'forbidden') {
    return 'forbidden';
  }
  if (status.runtimeState === 'unconfigured') {
    return 'unconfigured';
  }
  return status.executionMode ?? 'unknown';
}

export function isLiveSafetyViolation(status: PaymentExecutionStatus): boolean {
  return (
    status.deploymentEnvironment === 'live' &&
    (status.runtimeState === 'forbidden' ||
      status.runtimeState === 'conflict' ||
      status.executionMode === 'simulation' ||
      status.executionMode === 'sandbox')
  );
}
