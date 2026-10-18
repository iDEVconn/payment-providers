import { formatEnvBanner, missingEnv } from './host-env-banner';
import type {
  PaymentAccountContext,
  PaymentExecutionStatus,
  PaymentProviderDescriptor,
} from '../../contracts/index';
import { evaluateCapabilities } from './evaluate-capabilities';
import { type EnvGetter, readEnvEnabled, readPaymentEnvironment } from './env-access';

export const PAYMENT_MS_ENV_PATH = 'apps/microservices/payment/.env';

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
  get: EnvGetter;
  nodeEnv?: string;
  providerCode?: string;
  envPath?: string;
  executionStatus?: PaymentExecutionStatus;
};

function resolveContext(get: EnvGetter, providerCode: string): PaymentAccountContext {
  return {
    providerCode,
    accountRef: get('PAYPAL_ACCOUNT_REF')?.trim() || 'default',
    environment: readPaymentEnvironment(get),
    applicationRef: get('PAYMENT_APPLICATION_REF')?.trim() || 'edc',
  };
}

function checkoutEnabled(get: EnvGetter): boolean {
  return readEnvEnabled(get, 'PAYPAL_CHECKOUT_ENABLED', true);
}

function readRequestTimeoutMs(get: EnvGetter): number | undefined {
  const raw = get('PAYPAL_REQUEST_TIMEOUT_MS')?.trim();
  if (!raw) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid PAYPAL_REQUEST_TIMEOUT_MS: ${raw}`);
  }
  return parsed;
}

function buildConfigBanner(providerCode: string, missing: string[], envPath: string): string {
  return formatEnvBanner({
    service: 'payment MS',
    provider: providerCode,
    missing,
    envPath,
    headline: `⚠  payment MS — ${providerCode} credentials missing (payments will fail)`,
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

function assertPaypalEnvironmentMatchesExecutionMode(
  status: PaymentExecutionStatus,
  paypalEnvironment: PaymentAccountContext['environment'],
): void {
  if (status.executionMode === 'sandbox' && paypalEnvironment !== 'sandbox') {
    throw new Error('PAYPAL_ENVIRONMENT must be sandbox when PAYMENT_EXECUTION_MODE=sandbox');
  }
  if (status.executionMode === 'live' && paypalEnvironment !== 'live') {
    throw new Error('PAYPAL_ENVIRONMENT must be live when PAYMENT_EXECUTION_MODE=live');
  }
}

export function resolvePaymentRuntime(input: ResolvePaymentRuntimeInput): ResolvedPaymentRuntime {
  const providerCode = (input.providerCode ?? input.get('PAYMENT_PROVIDER') ?? 'paypal').trim();
  const context = resolveContext(input.get, providerCode);
  const capabilities = evaluateCapabilities(input.get, context);
  const descriptor: PaymentProviderDescriptor = { ...context, capabilities };
  const executionStatus = input.executionStatus;
  const envPath = input.envPath ?? PAYMENT_MS_ENV_PATH;
  const isProduction = input.nodeEnv === 'production';

  if (
    executionStatus?.runtimeState === 'forbidden' ||
    executionStatus?.runtimeState === 'conflict'
  ) {
    const banner = formatEnvBanner({
      service: 'payment MS',
      provider: providerCode,
      missing: executionStatus.issues.map((row) => row.code),
      envPath,
      headline: `⚠  payment MS — payment execution mode is ${executionStatus.runtimeState}`,
    });
    if (isProduction || executionStatus.deploymentEnvironment === 'live') {
      throw new Error(banner);
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
      executionStatus?.runtimeState === 'unconfigured'
        ? formatEnvBanner({
            service: 'payment MS',
            provider: providerCode,
            missing: executionStatus.issues.map((row) => row.code),
            envPath,
            headline:
              '⚠  payment MS — payment execution mode is unconfigured (provider calls rejected)',
          })
        : undefined;
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

  if (!checkoutEnabled(input.get)) {
    return { mode: 'live-provider', context, descriptor };
  }

  const missing = missingEnv(input.get, ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET']);
  if (missing.length === 0) {
    const clientId = input.get('PAYPAL_CLIENT_ID')?.trim();
    const clientSecret = input.get('PAYPAL_CLIENT_SECRET')?.trim();
    if (!clientId || !clientSecret) {
      throw new Error('Checkout credentials resolved empty after validation');
    }

    if (executionStatus?.runtimeState === 'configured' && executionStatus.executionMode) {
      assertPaypalEnvironmentMatchesExecutionMode(executionStatus, context.environment);
    }

    return {
      mode: 'live-provider',
      context,
      descriptor,
      checkoutCredentials: {
        clientId,
        clientSecret,
        environment: context.environment,
        requestTimeoutMs: readRequestTimeoutMs(input.get),
      },
    };
  }

  if (executionStatus?.runtimeState === 'configured') {
    const banner = buildConfigBanner(providerCode, missing, envPath);
    throw new Error(banner);
  }

  const banner = buildConfigBanner(providerCode, missing, envPath);
  if (isProduction) {
    throw new Error(banner);
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
