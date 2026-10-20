import type { PaymentEnvironment } from './capabilities';
import type { CanonicalMoney } from './money';
import type {
  NormalizedPaymentFailure,
  PaymentNextAction,
  PaymentResultOutcome,
} from './operation-result';
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
  providerOrderId?: string | null;
  checkoutOperationId?: string | null;
};

/** Explicit recovery for checkout create stuck in unknown or abandoned submitted without provider ids. */
export type RetryCheckoutOrderRequest = CheckoutProviderContext & {
  checkoutOperationId: string;
  amount: CanonicalMoney;
  referenceId?: string | null;
  returnUrl?: string | null;
  cancelUrl?: string | null;
};

export type CheckoutProviderCreateRetryEligibility = 'allowed' | 'expired' | 'unavailable';

export type CaptureCheckoutOrderRequest = CheckoutProviderContext & {
  idempotencyKey: string;
  correlationId?: string | null;
  checkoutOperationId: string;
  providerOrderId: string;
};

type CheckoutOrderBase = {
  operationId: string;
  operationKind: 'checkout';
  operationStatus: PaymentOperationStatus;
  providerOrderId: string | null;
  checkoutStatus: CheckoutOrderStatus;
  amount: CanonicalMoney;
  approvalUrl: string | null;
  correlationId: string | null;
  providerDebugId?: string | null;
};

export type CheckoutOrderResult = CheckoutOrderBase &
  (
    | {
        outcome: 'requires_action';
        nextAction: 'approve';
        providerOrderId: string;
        approvalUrl: string;
      }
    | { outcome: 'pending'; nextAction: 'check_status' }
    | { outcome: 'succeeded'; nextAction: 'none'; providerOrderId: string }
    | {
        outcome: 'failed';
        nextAction: PaymentNextAction;
        failure: NormalizedPaymentFailure;
      }
    | {
        outcome: 'unknown';
        nextAction: 'check_status' | 'resume_operation' | 'contact_support';
        uncertaintyReason: string;
      }
  );

type CheckoutCaptureBase = {
  operationId: string;
  operationKind: 'capture';
  operationStatus: PaymentOperationStatus;
  checkoutOperationId: string;
  providerOrderId: string;
  providerCaptureId: string | null;
  captureStatus: CheckoutOrderStatus;
  amount: CanonicalMoney | null;
  correlationId: string | null;
  providerDebugId?: string | null;
};

export type CheckoutCaptureResult = CheckoutCaptureBase &
  (
    | {
        outcome: 'requires_action';
        nextAction: 'approve';
        approvalUrl?: string | null;
      }
    | { outcome: 'pending'; nextAction: 'check_status' }
    | {
        outcome: 'succeeded';
        nextAction: 'none';
        providerCaptureId: string;
        amount: CanonicalMoney;
      }
    | {
        outcome: 'failed';
        nextAction: PaymentNextAction;
        failure: NormalizedPaymentFailure;
      }
    | {
        outcome: 'unknown';
        nextAction: 'check_status' | 'resume_operation' | 'contact_support';
        uncertaintyReason: string;
      }
  );

export type { PaymentResultOutcome };

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
