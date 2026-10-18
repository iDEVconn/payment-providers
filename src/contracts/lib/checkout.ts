import type { PaymentEnvironment } from './capabilities';
import type { CanonicalMoney } from './money';
import type { PaymentOperationStatus } from './operations';

export type CheckoutOrderStatus =
  | 'created'
  | 'approved'
  | 'captured'
  | 'failed'
  | 'unknown'
  | 'voided';

export type CheckoutProviderContext = {
  providerCode: string;
  accountRef: string;
  applicationRef: string;
  environment: PaymentEnvironment;
};

export type CreateCheckoutOrderRequest = CheckoutProviderContext & {
  idempotencyKey: string;
  correlationId?: string | null;
  amount: CanonicalMoney;
  referenceId?: string | null;
  returnUrl?: string | null;
  cancelUrl?: string | null;
};

export type GetCheckoutOrderRequest = CheckoutProviderContext & {
  providerOrderId: string;
};

export type CaptureCheckoutOrderRequest = CheckoutProviderContext & {
  idempotencyKey: string;
  correlationId?: string | null;
  checkoutOperationId: string;
  providerOrderId: string;
};

export type CheckoutOrderResult = {
  operationId: string;
  operationStatus: PaymentOperationStatus;
  providerOrderId: string | null;
  checkoutStatus: CheckoutOrderStatus;
  amount: CanonicalMoney;
  approvalUrl: string | null;
  correlationId: string | null;
  providerDebugId?: string | null;
};

export type CheckoutCaptureResult = {
  operationId: string;
  operationStatus: PaymentOperationStatus;
  checkoutOperationId: string;
  providerOrderId: string;
  providerCaptureId: string | null;
  captureStatus: CheckoutOrderStatus;
  amount: CanonicalMoney | null;
  correlationId: string | null;
  providerDebugId?: string | null;
};

/** Provider execution payload for payment.checkout.create — no durable fields. */
export type ExecuteCreateCheckoutOrderRequest = CheckoutProviderContext & {
  providerRequestId: string;
  amount: CanonicalMoney;
  referenceId?: string | null;
  returnUrl?: string | null;
  cancelUrl?: string | null;
};

export type ExecuteCreateCheckoutOrderResult = {
  providerOrderId: string;
  checkoutStatus: CheckoutOrderStatus;
  approvalUrl: string | null;
  amount: CanonicalMoney;
  providerDebugId?: string | null;
};

export type ExecuteGetCheckoutOrderRequest = CheckoutProviderContext & {
  providerOrderId: string;
};

export type ExecuteGetCheckoutOrderResult = {
  providerOrderId: string;
  checkoutStatus: CheckoutOrderStatus;
  approvalUrl: string | null;
  amount: CanonicalMoney | null;
  captureAmount: CanonicalMoney | null;
  providerCaptureId: string | null;
  providerCaptureStatus: CheckoutOrderStatus | null;
  providerDebugId?: string | null;
};

export type ExecuteCaptureCheckoutOrderRequest = CheckoutProviderContext & {
  providerRequestId: string;
  providerOrderId: string;
};

export type ExecuteCaptureCheckoutOrderResult = {
  providerOrderId: string;
  providerCaptureId: string | null;
  providerCaptureStatus: CheckoutOrderStatus | null;
  captureStatus: CheckoutOrderStatus;
  amount: CanonicalMoney | null;
  providerDebugId?: string | null;
};
