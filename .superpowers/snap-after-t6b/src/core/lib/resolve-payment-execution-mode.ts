import type {
  NormalizedDeployedPaymentConfig,
  PaymentDeploymentEnvironment,
  PaymentExecutionIssue,
  PaymentExecutionMode,
  PaymentExecutionModeSource,
  PaymentExecutionStatus,
  PaymentRuntimeState,
} from '../../contracts/index';

/** @deprecated Legacy env name — read only at composition root for conflict detection. */
export const PAYMENT_EXECUTION_MODE_ENV = 'PAYMENT_EXECUTION_MODE';
/** @deprecated Legacy env name — read only at composition root for conflict detection. */
export const PAYMENT_DEPLOYMENT_ENVIRONMENT_ENV = 'PAYMENT_DEPLOYMENT_ENVIRONMENT';
/** @deprecated Legacy env name — read only at composition root for conflict detection. */
export const FUNDING_SIMULATION_ENV = 'FUNDING_SIMULATION';

function issue(code: PaymentExecutionIssue['code']): PaymentExecutionIssue {
  return { code };
}

function normalize(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

function deriveDeploymentEnvironment(
  nodeEnv: string,
  providerEnvironment: 'sandbox' | 'live' | null,
  financialSimulation: boolean,
): PaymentDeploymentEnvironment | null {
  if (financialSimulation) {
    return 'ci';
  }
  if (nodeEnv === 'production') {
    if (providerEnvironment === 'live') {
      return 'live';
    }
    if (providerEnvironment === 'sandbox') {
      return 'staging';
    }
    return null;
  }
  if (providerEnvironment === 'sandbox' || providerEnvironment === 'live') {
    return 'local';
  }
  return null;
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

function detectLegacyConflicts(
  normalized: NormalizedDeployedPaymentConfig,
  derivedExecutionMode: PaymentExecutionMode | null,
  derivedDeployment: PaymentDeploymentEnvironment | null,
  issues: PaymentExecutionIssue[],
): boolean {
  let conflict = false;

  const legacyMode = normalize(normalized.legacyPaymentExecutionMode);
  if (legacyMode) {
    if (legacyMode === 'simulation') {
      issues.push(issue('LEGACY_ALIAS_CONFLICT'));
      conflict = true;
    } else if (
      derivedExecutionMode &&
      legacyMode !== derivedExecutionMode &&
      (legacyMode === 'sandbox' || legacyMode === 'live')
    ) {
      issues.push(issue('PAYPAL_ENVIRONMENT_MISMATCH'));
      conflict = true;
    } else if (legacyMode !== 'sandbox' && legacyMode !== 'live' && legacyMode !== 'simulation') {
      issues.push(issue('INVALID_EXECUTION_MODE'));
      conflict = true;
    }
  }

  const legacyDeployment = normalize(normalized.legacyPaymentDeploymentEnvironment);
  if (legacyDeployment && derivedDeployment && legacyDeployment !== derivedDeployment) {
    issues.push(issue('LEGACY_ALIAS_CONFLICT'));
    conflict = true;
  }

  if (normalize(normalized.legacyFundingSimulation)) {
    issues.push(issue('LEGACY_ALIAS_CONFLICT'));
    conflict = true;
  }

  return conflict;
}

export function resolvePaymentExecutionMode(
  normalized: NormalizedDeployedPaymentConfig,
): PaymentExecutionStatus {
  const issues: PaymentExecutionIssue[] = [];
  const isProduction = normalized.nodeEnv === 'production';
  const financialSimulation = normalized.financialSimulation === true;

  if (financialSimulation) {
    if (isProduction) {
      issues.push(issue('SIMULATION_FORBIDDEN_IN_PRODUCTION'));
      return buildStatus({
        executionMode: null,
        deploymentEnvironment: null,
        runtimeState: 'forbidden',
        source: 'test-simulation',
        issues,
      });
    }
    if (detectLegacyConflicts(normalized, 'simulation', 'ci', issues)) {
      return buildStatus({
        executionMode: 'simulation',
        deploymentEnvironment: 'ci',
        runtimeState: 'conflict',
        source: 'legacy-alias',
        issues,
      });
    }
    return buildStatus({
      executionMode: 'simulation',
      deploymentEnvironment: 'ci',
      runtimeState: 'configured',
      source: 'test-simulation',
      issues,
    });
  }

  const parsed = parsePaypalEnvironment(normalized, issues);
  if (!parsed) {
    return buildStatus({
      executionMode: null,
      deploymentEnvironment: null,
      runtimeState: 'forbidden',
      source: 'unconfigured',
      issues,
    });
  }

  const executionMode: PaymentExecutionMode = parsed;
  const deploymentEnvironment = deriveDeploymentEnvironment(normalized.nodeEnv, parsed, false);

  if (detectLegacyConflicts(normalized, executionMode, deploymentEnvironment, issues)) {
    return buildStatus({
      executionMode,
      deploymentEnvironment,
      runtimeState: 'conflict',
      source: 'legacy-alias',
      issues,
    });
  }

  return buildStatus({
    executionMode,
    deploymentEnvironment,
    runtimeState: 'configured',
    source: 'provider-environment',
    issues,
  });
}

function parsePaypalEnvironment(
  normalized: NormalizedDeployedPaymentConfig,
  issues: PaymentExecutionIssue[],
): 'sandbox' | 'live' | null {
  const env = normalized.providerEnvironment;
  if (env === 'sandbox' || env === 'live') {
    return env;
  }
  issues.push(
    issue(
      normalized.providerEnvironmentInvalid
        ? 'INVALID_PROVIDER_ENVIRONMENT'
        : 'MISSING_PROVIDER_ENVIRONMENT',
    ),
  );
  return null;
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

export function shouldAbortPaymentStartup(
  status: PaymentExecutionStatus,
  nodeEnv: string,
): boolean {
  if (isLiveSafetyViolation(status)) {
    return true;
  }
  if (nodeEnv === 'production' && status.runtimeState !== 'configured') {
    return true;
  }
  if (nodeEnv === 'production' && status.executionMode === 'simulation') {
    return true;
  }
  return false;
}
