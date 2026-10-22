/*
 * Structural copies of the legacy `@idevconn/payment` checkout types. `@idevconn/payment`
 * is an optional peer, so root, `/paypal` and `/subscription` declarations must not import
 * it. Same shapes as `@idevconn/payment@1.2`; the real types stay on `/legacy`.
 */

/** @deprecated Import the real type from `@idevconn/payment-providers/legacy`. */
export type CreateOrderInput = {
  amount: string;
  currency: string;
  referenceId?: string;
  returnUrl?: string;
  cancelUrl?: string;
};

/** @deprecated Import the real type from `@idevconn/payment-providers/legacy`. */
export type OrderResult = {
  orderId: string;
  status: string;
  approveUrl?: string;
};

/** @deprecated Import the real type from `@idevconn/payment-providers/legacy`. */
export type CaptureResult = {
  orderId: string;
  status: string;
  payer?: Record<string, unknown>;
  purchaseUnits?: Record<string, unknown>[];
};

/** @deprecated Import the real type from `@idevconn/payment-providers/legacy`. */
export type RequestOptions = {
  idempotencyKey?: string;
};

/** @deprecated Import the real type from `@idevconn/payment-providers/legacy`. */
export type PaymentStrategy = {
  readonly name: string;
  createOrder(input: CreateOrderInput, options?: RequestOptions): Promise<OrderResult>;
  captureOrder(orderId: string, options?: RequestOptions): Promise<CaptureResult>;
};

/** @deprecated Import the real type from `@idevconn/payment-providers/legacy`. */
export type PaymentErrorCode =
  | 'VALIDATION_FAILED'
  | 'PROVIDER_NOT_REGISTERED'
  | 'NOT_SUPPORTED'
  | 'PROVIDER_ERROR'
  | 'INTERNAL_ERROR';

/** @deprecated Import the real type from `@idevconn/payment-providers/legacy`. */
export interface PaymentError extends Error {
  readonly code: PaymentErrorCode;
  readonly statusCode: number;
  readonly details?: Record<string, unknown> | undefined;
  toResponseBody(): Record<string, unknown>;
}
