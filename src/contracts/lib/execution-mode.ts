export type PaymentExecutionMode = 'simulation' | 'sandbox' | 'live';

export type PaymentDeploymentEnvironment = 'local' | 'ci' | 'staging' | 'live';

export type PaymentRuntimeState = 'configured' | 'unconfigured' | 'conflict' | 'forbidden';

export type PaymentExecutionModeSource =
  | 'provider-environment'
  | 'explicit'
  | 'legacy-alias'
  | 'unconfigured'
  | 'test-simulation';

import type { PaymentEnvironment } from './capabilities';

export type { PaymentEnvironment };

export type PaymentExecutionIssueCode =
  | 'MISSING_PROVIDER_ENVIRONMENT'
  | 'INVALID_PROVIDER_ENVIRONMENT'
  | 'MISSING_DEPLOYMENT_ENVIRONMENT'
  | 'INVALID_DEPLOYMENT_ENVIRONMENT'
  | 'MISSING_EXECUTION_MODE'
  | 'INVALID_EXECUTION_MODE'
  | 'DEPLOYMENT_MODE_FORBIDDEN'
  | 'LEGACY_ALIAS_CONFLICT'
  | 'LEGACY_ALIAS_FORBIDDEN_IN_LIVE'
  | 'PAYPAL_ENVIRONMENT_MISMATCH'
  | 'EXECUTION_MODE_MISMATCH'
  | 'SIMULATION_FORBIDDEN_IN_PRODUCTION';

/** Provider-neutral input assembled at the application composition root. */
export type NormalizedDeployedPaymentConfig = {
  nodeEnv: string;
  /** Parsed PayPal sandbox/live; null when missing or invalid. */
  providerEnvironment: PaymentEnvironment | null;
  /** Set when PAYPAL_ENVIRONMENT was present but not sandbox|live. */
  providerEnvironmentInvalid?: boolean;
  /** Test harness injection only — never from operator deploy env. */
  financialSimulation?: boolean;
  legacyPaymentExecutionMode?: string | null;
  legacyPaymentDeploymentEnvironment?: string | null;
  legacyFundingSimulation?: string | null;
};

export type PaymentExecutionIssue = {
  code: PaymentExecutionIssueCode;
};

/** Secret-free execution status for cross-process and public reporting. */
export type PaymentExecutionStatus = {
  executionMode: PaymentExecutionMode | null;
  deploymentEnvironment: PaymentDeploymentEnvironment | null;
  runtimeState: PaymentRuntimeState;
  providerCallsEnabled: boolean;
  simulatedExecutionEnabled: boolean;
  source: PaymentExecutionModeSource;
  issues: PaymentExecutionIssue[];
};

/** Trusted server-generated stamp for internal financial RPCs. */
export type PaymentExecutionContext = {
  executionMode: PaymentExecutionMode;
  deploymentEnvironment: PaymentDeploymentEnvironment;
  applicationRef: string;
};

/** Additive envelope for internal financial RPC payloads. */
export type PaymentExecutionRequest<T> = {
  request: T;
  executionContext?: PaymentExecutionContext;
};

/** Backward-compatible RPC payload accepted by stamped and transitional callers. */
export type PaymentExecutionPayload<T> = T | PaymentExecutionRequest<T>;

export type PaymentExecutionStatusResponse = PaymentExecutionStatus & {
  displayLabel: string;
};

export type PaymentCapabilityStatusSnapshot = {
  capability: 'payout';
  ready: boolean;
  enabled: boolean;
  configured: boolean;
  unavailableReason?: string;
};

export type GatewayPaymentExecutionStatusResponse = PaymentExecutionStatusResponse & {
  gateway: PaymentExecutionStatusResponse;
  paymentMicroservice: PaymentExecutionStatusResponse | null;
  processesAgree: boolean;
  paymentMicroserviceAvailable: boolean;
  payoutCapability: PaymentCapabilityStatusSnapshot | null;
};

export const EXECUTION_MODE_MISMATCH = 'EXECUTION_MODE_MISMATCH' as const;
export const EXECUTION_MODE_BLOCKED = 'EXECUTION_MODE_BLOCKED' as const;

export type PersistedPaymentExecutionMode = PaymentExecutionMode;

export const PERSISTED_PAYMENT_EXECUTION_MODES: readonly PersistedPaymentExecutionMode[] = [
  'simulation',
  'sandbox',
  'live',
] as const;
