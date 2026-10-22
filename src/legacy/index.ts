/**
 * Legacy `@idevconn/payment` checkout surface. This is the only entry that loads
 * `@idevconn/payment` at runtime; install it (optional peer) before importing here.
 */
export { PaymentError as LegacyPaymentError } from '@idevconn/payment';
export type {
  CaptureResult,
  CreateOrderInput,
  OrderResult,
  PaymentError,
  PaymentErrorCode,
  RequestOptions,
} from '@idevconn/payment';
export * from '../paypal/lib/paypal-payment-provider';
