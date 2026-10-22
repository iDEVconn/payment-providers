import type { NormalizedDeployedPaymentConfig, PaymentEnvironment } from '../../contracts/index';

export type ParsePaypalEnvironmentResult =
  | { ok: true; environment: PaymentEnvironment }
  | { ok: false; reason: 'missing' | 'invalid'; raw?: string };

export function parsePaypalEnvironment(value: string | null | undefined): ParsePaypalEnvironmentResult {
  const raw = value?.trim().toLowerCase();
  if (!raw) {
    return { ok: false, reason: 'missing' };
  }
  if (raw === 'sandbox' || raw === 'live') {
    return { ok: true, environment: raw };
  }
  return { ok: false, reason: 'invalid', raw: value?.trim() };
}

export function buildNormalizedDeployedPaymentConfig(input: {
  nodeEnv?: string;
  providerEnvironment: PaymentEnvironment | null;
  providerEnvironmentInvalid?: boolean;
  financialSimulation?: boolean;
  legacyPaymentExecutionMode?: string | null;
  legacyPaymentDeploymentEnvironment?: string | null;
  legacyFundingSimulation?: string | null;
}): NormalizedDeployedPaymentConfig {
  return {
    nodeEnv: input.nodeEnv ?? 'development',
    providerEnvironment: input.providerEnvironment,
    providerEnvironmentInvalid: input.providerEnvironmentInvalid === true,
    financialSimulation: input.financialSimulation === true ? true : undefined,
    legacyPaymentExecutionMode: input.legacyPaymentExecutionMode ?? null,
    legacyPaymentDeploymentEnvironment: input.legacyPaymentDeploymentEnvironment ?? null,
    legacyFundingSimulation: input.legacyFundingSimulation ?? null,
  };
}
