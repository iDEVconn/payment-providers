import type {
  NormalizedDeployedPaymentConfig,
  PaymentExecutionStatus,
} from '../../contracts/index';

export type PaymentExecutionConfigAdapterInput = {
  normalized: NormalizedDeployedPaymentConfig;
  serviceLabel: string;
  applicationRef: string;
};

export type ResolvedPaymentExecutionConfig = {
  status: PaymentExecutionStatus;
  displayLabel: string;
  applicationRef: string;
  normalized: NormalizedDeployedPaymentConfig;
  startupBanner?: string;
  abortStartup: boolean;
};
