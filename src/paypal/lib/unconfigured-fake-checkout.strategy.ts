import type {
  CaptureResult,
  CreateOrderInput,
  OrderResult,
  PaymentStrategy,
  RequestOptions,
} from '../../contracts/lib/legacy-checkout';
import { PAYMENT_CAPABILITY_UNAVAILABLE, PAYMENT_CAUSE_CODE } from '../../contracts/index';

export class UnconfiguredFakeCheckoutStrategy implements PaymentStrategy {
  constructor(readonly name: string) {}

  createOrder(_input: CreateOrderInput, _options?: RequestOptions): Promise<OrderResult> {
    return Promise.reject(this.notConfigured());
  }

  captureOrder(_orderId: string, _options?: RequestOptions): Promise<CaptureResult> {
    return Promise.reject(this.notConfigured());
  }

  private notConfigured(): {
    code: typeof PAYMENT_CAPABILITY_UNAVAILABLE;
    message: string;
    causeCode: string;
    retryable: false;
    uncertain: false;
  } {
    return {
      code: PAYMENT_CAPABILITY_UNAVAILABLE,
      causeCode: PAYMENT_CAUSE_CODE.CHECKOUT_CREDENTIALS_MISSING,
      message: 'Payment capability is unavailable',
      retryable: false,
      uncertain: false,
    };
  }
}
