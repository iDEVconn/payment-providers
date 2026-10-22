import {
  formatConfigurationIssue,
  PaymentConfigurationError,
  requireApplicationRef,
} from './payment-configuration-error';
import type {
  PaymentAccountContext,
  PaymentEnvironment,
  PaymentExecutionStatus,
  PaymentProviderDescriptor,
} from '../../contracts/index';
import { evaluateCapabilities } from './evaluate-capabilities';
import type { PaymentProviderConfig } from './payment-provider-config';

export type PaymentRuntimeMode = 'live-provider' | 'fake';

export type ResolvedCheckoutCredentials = {
  clientId: string;
  clientSecret: string;
  environment: PaymentAccountContext['environment'];
  requestTimeoutMs?: number;
};

export type ResolvedPaymentRuntime = {
  mode: PaymentRuntimeMode;
  context: PaymentAccountContext;
  descriptor: PaymentProviderDescriptor;
  configBanner?: string;
  checkoutCredentials?: ResolvedCheckoutCredentials;
};

export type ResolvePaymentRuntimeInput = {
  config: PaymentProviderConfig;
  nodeEnv?: string;
  executionStatus?: PaymentExecutionStatus;
  /**
   * Production normally refuses a reject-only runtime (missing credentials, unconfigured or
   * simulated execution) so a misconfigured deployment cannot boot "healthy". Set this only for a
   * deployment that intentionally runs without payments. Forbidden/conflicting modes still throw.
   */
  allowRejectOnlyInProduction?: boolean;
};

function resolveContext(config: PaymentProviderConfig): PaymentAccountContext {
  return {
    providerCode: (config.providerCode ?? 'paypal').trim(),
    accountRef: config.accountRef?.trim() || 'default',
    environment: config.environment,
    applicationRef: requireApplicationRef(config.applicationRef),
  };
}

function checkoutEnabled(config: PaymentProviderConfig): boolean {
  if (config.capabilityFlags?.checkout !== undefined) {
    return config.capabilityFlags.checkout === true;
  }
  return true;
}

function readRequestTimeoutMs(config: PaymentProviderConfig): number | undefined {
  const raw = config.credentials?.requestTimeoutMs;
  if (raw == null) {
    return undefined;
  }
  if (!Number.isFinite(raw) || raw <= 0) {
    throw new Error('Invalid requestTimeoutMs in payment provider configuration');
  }
  return raw;
}

function buildConfigBanner(providerCode: string, missingFields: string[]): string {
  return formatConfigurationIssue({
    headline: `Payment provider "${providerCode}" credentials are missing (payments will fail)`,
    missingFields,
  });
}

function forceFakeCapabilityReadiness(
  capabilities: PaymentProviderDescriptor['capabilities'],
): PaymentProviderDescriptor['capabilities'] {
  return capabilities.map((row) =>
    row.capability === 'refund' || row.capability === 'payout' || row.capability === 'subscription'
      ? {
          ...row,
          ready: false,
          unavailableReason:
            row.unavailableReason ??
            `${row.capability} execution is unavailable while PayPal runtime is unconfigured`,
        }
      : row,
  );
}

/**
 * The documented network kill switch: a configured live/sandbox status with provider calls turned
 * off. It is an intentional, temporary state, so production does not throw for it; PayPal calls are
 * rejected and webhooks are stored pending (`verification_unavailable`) until it is lifted.
 */
export function isProviderCallsKillSwitch(status: PaymentExecutionStatus | undefined): boolean {
  return (
    status?.runtimeState === 'configured' &&
    status.executionMode !== 'simulation' &&
    !status.providerCallsEnabled
  );
}

function executionRequiresRejectOnly(status: PaymentExecutionStatus | undefined): boolean {
  if (!status) {
    return false;
  }
  return (
    status.runtimeState !== 'configured' ||
    status.executionMode === 'simulation' ||
    !status.providerCallsEnabled
  );
}

const CHECKOUT_CREDENTIAL_FIELDS = ['credentials.clientId', 'credentials.clientSecret'] as const;

export function resolvePaymentRuntime(input: ResolvePaymentRuntimeInput): ResolvedPaymentRuntime {
  const config = input.config;
  const providerCode = (config.providerCode ?? 'paypal').trim();
  const context = resolveContext(config);
  const capabilities = evaluateCapabilities(config, context);
  const descriptor: PaymentProviderDescriptor = { ...context, capabilities };
  const executionStatus = input.executionStatus;
  const isProduction = input.nodeEnv === 'production';
  const refuseRejectOnly = isProduction && input.allowRejectOnlyInProduction !== true;

  if (
    executionStatus?.runtimeState === 'forbidden' ||
    executionStatus?.runtimeState === 'conflict'
  ) {
    const banner = formatConfigurationIssue({
      headline: `Payment execution mode is ${executionStatus.runtimeState}`,
      missingFields: executionStatus.issues.map((row) => row.code),
    });
    if (isProduction || executionStatus.deploymentEnvironment === 'live') {
      throw new PaymentConfigurationError(banner, [
        'executionStatus.runtimeState',
        ...executionStatus.issues.map((row) => row.code),
      ]);
    }
    return {
      mode: 'fake',
      context,
      descriptor: {
        ...context,
        capabilities: forceFakeCapabilityReadiness(capabilities),
      },
      configBanner: banner,
    };
  }

  if (executionRequiresRejectOnly(executionStatus)) {
    const banner =
      executionStatus?.runtimeState !== 'configured'
        ? formatConfigurationIssue({
            headline: 'Payment execution is not configured (provider calls rejected)',
            missingFields: executionStatus?.issues.map((row) => row.code) ?? [],
          })
        : undefined;
    if (refuseRejectOnly && !isProviderCallsKillSwitch(executionStatus)) {
      const missingFields = rejectOnlyExecutionFields(executionStatus);
      throw new PaymentConfigurationError(
        banner ??
          formatConfigurationIssue({
            headline: 'Payment execution rejects provider calls; production requires live execution',
            missingFields,
          }),
        missingFields,
      );
    }
    return {
      mode: 'fake',
      context,
      descriptor: {
        ...context,
        capabilities: forceFakeCapabilityReadiness(capabilities),
      },
      configBanner: banner,
    };
  }

  const clientId = config.credentials?.clientId?.trim();
  const clientSecret = config.credentials?.clientSecret?.trim();
  const missingCredentialFields = missingCheckoutCredentialFields(clientId, clientSecret);

  if (refuseRejectOnly && missingCredentialFields.length > 0 && !executionStatus) {
    throw productionCredentialsError(providerCode, [...missingCredentialFields, 'executionStatus']);
  }

  if (!checkoutEnabled(config)) {
    return { mode: 'live-provider', context, descriptor };
  }

  if (clientId && clientSecret) {
    return {
      mode: 'live-provider',
      context,
      descriptor,
      checkoutCredentials: {
        clientId,
        clientSecret,
        environment: context.environment,
        requestTimeoutMs: readRequestTimeoutMs(config),
      },
    };
  }

  if (refuseRejectOnly) {
    throw productionCredentialsError(providerCode, missingCredentialFields);
  }

  const banner = buildConfigBanner(providerCode, [...CHECKOUT_CREDENTIAL_FIELDS]);
  return {
    mode: 'fake',
    context,
    descriptor: {
      ...context,
      capabilities: reinforceMissingCredentialReadiness(capabilities),
    },
    configBanner: banner,
  };
}

function rejectOnlyExecutionFields(status: PaymentExecutionStatus | undefined): string[] {
  const fields: string[] = [];
  if (status?.runtimeState !== 'configured') {
    fields.push('executionStatus.runtimeState');
  }
  if (!status?.providerCallsEnabled) {
    fields.push('executionStatus.providerCallsEnabled');
  }
  return [...fields, ...(status?.issues.map((row) => row.code) ?? [])];
}

function missingCheckoutCredentialFields(
  clientId: string | undefined,
  clientSecret: string | undefined,
): string[] {
  const fields: string[] = [];
  if (!clientId) {
    fields.push('credentials.clientId');
  }
  if (!clientSecret) {
    fields.push('credentials.clientSecret');
  }
  return fields;
}

/** Production never boots reject-only: missing setting names are listed, values never are. */
function productionCredentialsError(
  providerCode: string,
  missingFields: string[],
): PaymentConfigurationError {
  return new PaymentConfigurationError(
    formatConfigurationIssue({
      headline: `Payment provider "${providerCode}" is not configured for production`,
      missingFields,
    }),
    missingFields,
  );
}

function reinforceMissingCredentialReadiness(
  capabilities: PaymentProviderDescriptor['capabilities'],
): PaymentProviderDescriptor['capabilities'] {
  const label = CHECKOUT_CREDENTIAL_FIELDS.join(', ');
  return capabilities.map((row) => {
    if (row.ready) {
      return row;
    }
    return {
      ...row,
      ready: false,
      unavailableReason:
        row.unavailableReason ?? `Required configuration values are missing (${label})`,
    };
  });
}

export type { PaymentEnvironment };
