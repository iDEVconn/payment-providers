import type { PaymentExecutionContext, PaymentExecutionStatus } from '../../contracts/index';
import {
  formatConfigurationIssue,
  requireApplicationRef,
} from './payment-configuration-error';
import {
  executionStatusDisplayLabel,
  isLiveSafetyViolation,
  resolvePaymentExecutionMode,
  shouldAbortPaymentStartup,
} from './resolve-payment-execution-mode';
import type {
  PaymentExecutionConfigAdapterInput,
  ResolvedPaymentExecutionConfig,
} from './payment-execution-config-types';

export type {
  PaymentExecutionConfigAdapterInput,
  ResolvedPaymentExecutionConfig,
} from './payment-execution-config-types';

function bannerMissingKeys(status: PaymentExecutionStatus): string[] {
  return status.issues.map((row) => row.code);
}

export function resolvePaymentExecutionConfig(
  input: PaymentExecutionConfigAdapterInput,
): ResolvedPaymentExecutionConfig {
  const status = resolvePaymentExecutionMode(input.normalized);

  const applicationRef = requireApplicationRef(input.applicationRef);
  const displayLabel = executionStatusDisplayLabel(status);
  const abortStartup = shouldAbortPaymentStartup(status, input.normalized.nodeEnv);

  const needsBanner =
    abortStartup ||
    status.runtimeState === 'forbidden' ||
    status.runtimeState === 'conflict' ||
    status.issues.length > 0;

  const startupBanner = needsBanner
    ? formatConfigurationIssue({
        headline: abortStartup
          ? `${input.serviceLabel} — payment configuration error (startup aborted)`
          : isLiveSafetyViolation(status)
            ? `${input.serviceLabel} — payment execution mode safety violation`
            : `${input.serviceLabel} — payment configuration is incomplete`,
        missingFields: bannerMissingKeys(status),
      })
    : undefined;

  return {
    status,
    displayLabel,
    applicationRef,
    normalized: input.normalized,
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
