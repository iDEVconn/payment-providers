import type { PaymentExecutionContext, PaymentExecutionStatus } from '../../contracts/index';
import { formatEnvBanner } from './host-env-banner';
import {
  executionStatusDisplayLabel,
  FUNDING_SIMULATION_ENV,
  isLiveSafetyViolation,
  PAYMENT_DEPLOYMENT_ENVIRONMENT_ENV,
  PAYMENT_EXECUTION_MODE_ENV,
  resolvePaymentExecutionMode,
} from './resolve-payment-execution-mode';
import type { EnvGetter } from './env-access';

export type PaymentExecutionConfigAdapterInput = {
  get: EnvGetter;
  serviceLabel: string;
  envPath: string;
  applicationRef?: string;
};

export type ResolvedPaymentExecutionConfig = {
  status: PaymentExecutionStatus;
  displayLabel: string;
  applicationRef: string;
  startupBanner?: string;
  abortStartup: boolean;
};

export function resolvePaymentExecutionConfig(
  input: PaymentExecutionConfigAdapterInput,
): ResolvedPaymentExecutionConfig {
  const status = resolvePaymentExecutionMode({
    paymentExecutionMode: input.get(PAYMENT_EXECUTION_MODE_ENV),
    paymentDeploymentEnvironment: input.get(PAYMENT_DEPLOYMENT_ENVIRONMENT_ENV),
    fundingSimulation: input.get(FUNDING_SIMULATION_ENV),
  });

  const applicationRef =
    input.get('PAYMENT_APPLICATION_REF')?.trim() || input.applicationRef || 'edc';
  const displayLabel = executionStatusDisplayLabel(status);
  const abortStartup = isLiveSafetyViolation(status);

  const startupBanner = abortStartup
    ? formatEnvBanner({
        service: input.serviceLabel,
        provider: 'payment-execution',
        missing: status.issues.map((row) => row.code),
        envPath: input.envPath,
        headline: `⚠  ${input.serviceLabel} — payment execution mode safety violation (startup aborted)`,
      })
    : undefined;

  return {
    status,
    displayLabel,
    applicationRef,
    startupBanner,
    abortStartup,
  };
}

export function buildPaymentExecutionContext(
  config: ResolvedPaymentExecutionConfig,
): PaymentExecutionContext | null {
  const { status, applicationRef } = config;
  if (
    status.runtimeState !== 'configured' ||
    !status.executionMode ||
    !status.deploymentEnvironment
  ) {
    return null;
  }

  return {
    executionMode: status.executionMode,
    deploymentEnvironment: status.deploymentEnvironment,
    applicationRef,
  };
}
