import type { PaymentEnvironment } from './capabilities';
import type { CanonicalMoney } from './money';
import type { PaymentOperationStatus } from './operations';

export type RefundStatus = 'pending' | 'completed' | 'failed' | 'unknown';

export type RefundCaptureRequest = {
  providerCode: string;
  accountRef: string;
  applicationRef: string;
  environment: PaymentEnvironment;
  idempotencyKey: string;
  correlationId?: string | null;
  captureOperationId: string;
  providerCaptureId: string;
  amount?: CanonicalMoney | null;
};

export type RefundCaptureResult = {
  operationId: string;
  operationStatus: PaymentOperationStatus;
  captureOperationId: string;
  providerCaptureId: string;
  providerRefundId: string | null;
  refundStatus: RefundStatus;
  amount: CanonicalMoney | null;
  correlationId: string | null;
  providerDebugId?: string | null;
};

export type ExecuteRefundCaptureRequest = {
  providerCode: string;
  accountRef: string;
  applicationRef: string;
  environment: PaymentEnvironment;
  providerRequestId: string;
  providerCaptureId: string;
  amount?: CanonicalMoney | null;
};

export type ExecuteRefundCaptureResult = {
  providerRefundId: string;
  refundStatus: RefundStatus;
  amount: CanonicalMoney | null;
  providerDebugId?: string | null;
};

export type ExecuteGetRefundRequest = {
  providerCode: string;
  accountRef: string;
  applicationRef: string;
  environment: PaymentEnvironment;
  providerRefundId: string;
};

export type ExecuteGetRefundResult = {
  providerRefundId: string;
  refundStatus: RefundStatus;
  amount: CanonicalMoney | null;
  providerDebugId?: string | null;
};
