import { PaymentError, type OrderResult, type PaymentStrategy } from '@idevconn/payment';
import {
  PAYMENT_CAPABILITY_UNAVAILABLE,
  PAYMENT_RELIABILITY_ERROR,
  type ExecuteCaptureCheckoutOrderRequest,
  type ExecuteCaptureCheckoutOrderResult,
  type ExecuteCreateCheckoutOrderRequest,
  type ExecuteCreateCheckoutOrderResult,
  type ExecuteGetCheckoutOrderRequest,
  type ExecuteGetCheckoutOrderResult,
  type ExecuteGetRefundRequest,
  type ExecuteGetRefundResult,
  type ExecuteRefundCaptureRequest,
  type ExecuteRefundCaptureResult,
  type PaymentEnvironment,
} from '../../contracts/index';
import {
  assertCapabilityReady,
  pathSegment,
  canonicalMoneyToLegacyMajorAmount,
  type CheckoutProviderPort,
  type ResolvedPaymentRuntime,
} from '../../core/index';
import {
  resendWithFreshPaypalTokenOn401,
  type PaypalAccessTokenScope,
} from './paypal-access-token-retry';
import type { PaypalAccessTokenRequestOptions } from './paypal-oauth-client';
import { extractPaypalCheckoutApprovalUrl } from './paypal-checkout-approval-url';
import {
  extractPaypalIssueCodes,
  mapPaypalCaptureStatus,
  parsePurchaseUnitCaptures,
  resolveCheckoutStatusFromOrder,
} from './paypal-checkout-order-parsing';
import type {
  PaypalOrdersHttpClient,
  PaypalOrdersHttpRequest,
  PaypalOrdersHttpResponse,
} from './paypal-orders-http-client';
import { UnconfiguredFakeCheckoutStrategy } from './unconfigured-fake-checkout.strategy';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function majorToMinor(value: string, currency: string): string {
  const [whole = '0', fraction = ''] = value.split('.');
  const digits = currency === 'JPY' ? 0 : 2;
  const padded = fraction.padEnd(digits, '0').slice(0, digits);
  return `${whole}${padded}`.replace(/^0+(?=\d)/, '') || '0';
}

function mapRefundStatus(status: string): ExecuteGetRefundResult['refundStatus'] {
  switch (status) {
    case 'COMPLETED':
      return 'completed';
    case 'FAILED':
    case 'CANCELLED':
      return 'failed';
    case 'PENDING':
      return 'pending';
    default:
      return 'unknown';
  }
}

function buildCaptureResultFromBody(
  body: Record<string, unknown>,
  providerOrderId: string,
  debugId?: string | null,
): ExecuteCaptureCheckoutOrderResult {
  const capture = parsePurchaseUnitCaptures(body['purchase_units']);
  const providerCaptureStatus = capture ? mapPaypalCaptureStatus(capture.status) : null;
  const captureStatus =
    providerCaptureStatus === 'captured'
      ? 'captured'
      : providerCaptureStatus === 'failed'
        ? 'failed'
        : 'unknown';
  return {
    providerOrderId: String(body['id'] ?? providerOrderId),
    providerCaptureId: capture?.id ?? null,
    providerCaptureStatus,
    captureStatus,
    amount: capture?.amount ?? null,
    providerDebugId: debugId ?? null,
  };
}

export type PaypalCheckoutTokenProvider = (
  scope: {
    accountRef: string;
    environment: PaymentEnvironment;
  },
  options?: PaypalAccessTokenRequestOptions,
) => Promise<string>;

export class PaypalCheckoutExecutor implements CheckoutProviderPort {
  constructor(
    private readonly runtime: ResolvedPaymentRuntime,
    private readonly strategyFactory: () => PaymentStrategy,
    private readonly httpClient: PaypalOrdersHttpClient,
    private readonly tokenProvider: PaypalCheckoutTokenProvider,
  ) {}

  private authorizedRequest(
    scope: PaypalAccessTokenScope,
    token: string,
    request: Omit<PaypalOrdersHttpRequest, 'accessToken'>,
  ): Promise<PaypalOrdersHttpResponse> {
    return resendWithFreshPaypalTokenOn401(this.tokenProvider, scope, token, (accessToken) =>
      this.httpClient.request({ ...request, accessToken }),
    );
  }

  async createOrder(
    input: ExecuteCreateCheckoutOrderRequest,
  ): Promise<ExecuteCreateCheckoutOrderResult> {
    assertCapabilityReady(this.runtime.descriptor.capabilities, 'checkout');
    const strategy = this.strategyFactory();
    if (strategy instanceof UnconfiguredFakeCheckoutStrategy) {
      await this.rejectUnconfigured(strategy.createOrder({ amount: '0', currency: 'USD' }));
    }

    if (input.returnUrl || input.cancelUrl) {
      return this.createOrderWithExperienceContext(input);
    }

    const result: OrderResult = await strategy.createOrder(
      {
        amount: canonicalMoneyToLegacyMajorAmount(input.amount),
        currency: input.amount.currency,
        referenceId: input.referenceId ?? undefined,
        returnUrl: input.returnUrl ?? undefined,
        cancelUrl: input.cancelUrl ?? undefined,
      },
      { idempotencyKey: input.providerRequestId },
    );

    const approvalUrl = result.approveUrl
      ? extractPaypalCheckoutApprovalUrl(
          [{ rel: 'approve', href: result.approveUrl }],
          input.environment,
        )
      : null;

    return {
      providerOrderId: result.orderId,
      checkoutStatus: resolveCheckoutStatusFromOrder(result.status, null),
      approvalUrl,
      amount: input.amount,
      providerDebugId: result.orderId,
    };
  }

  async getOrder(input: ExecuteGetCheckoutOrderRequest): Promise<ExecuteGetCheckoutOrderResult> {
    assertCapabilityReady(this.runtime.descriptor.capabilities, 'checkout');
    const tokenScope = { accountRef: input.accountRef, environment: input.environment };
    const token = await this.tokenProvider(tokenScope);
    const baseUrl =
      input.environment === 'live'
        ? 'https://api-m.paypal.com'
        : 'https://api-m.sandbox.paypal.com';
    const response = await this.authorizedRequest(tokenScope, token, {
      method: 'GET',
      path: `${baseUrl}/v2/checkout/orders/${pathSegment(input.providerOrderId, 'providerOrderId')}`,
    });

    if (response.status === 404) {
      throw {
        code: PAYMENT_RELIABILITY_ERROR.PROVIDER_NOT_FOUND,
        message: 'PayPal order was not found',
        retryable: false,
        uncertain: false,
      };
    }
    if (response.status >= 500) {
      throw {
        code: PAYMENT_RELIABILITY_ERROR.PROVIDER_RETRYABLE,
        message: 'PayPal order lookup failed',
        retryable: true,
        uncertain: true,
      };
    }

    const purchaseUnits = response.body['purchase_units'];
    const firstUnit = Array.isArray(purchaseUnits) ? purchaseUnits[0] : undefined;
    const amountObj =
      firstUnit && typeof firstUnit === 'object'
        ? (firstUnit as { amount?: { currency_code?: string; value?: string } }).amount
        : undefined;
    const capture = parsePurchaseUnitCaptures(purchaseUnits);
    const orderStatus = String(response.body['status'] ?? 'UNKNOWN');

    return {
      providerOrderId: String(response.body['id'] ?? input.providerOrderId),
      checkoutStatus: resolveCheckoutStatusFromOrder(orderStatus, capture),
      approvalUrl: extractPaypalCheckoutApprovalUrl(response.body['links'], input.environment),
      amount:
        amountObj?.currency_code && amountObj.value
          ? {
              currency: amountObj.currency_code,
              amountMinor: majorToMinor(amountObj.value, amountObj.currency_code),
            }
          : null,
      captureAmount: capture?.amount ?? null,
      providerCaptureId: capture?.id ?? null,
      providerCaptureStatus: capture ? mapPaypalCaptureStatus(capture.status) : null,
      providerDebugId: response.debugId ?? null,
    };
  }

  async captureOrder(
    input: ExecuteCaptureCheckoutOrderRequest,
  ): Promise<ExecuteCaptureCheckoutOrderResult> {
    assertCapabilityReady(this.runtime.descriptor.capabilities, 'checkout');
    const strategy = this.strategyFactory();
    if (strategy instanceof UnconfiguredFakeCheckoutStrategy) {
      await this.rejectUnconfigured(strategy.captureOrder(input.providerOrderId));
    }

    const tokenScope = { accountRef: input.accountRef, environment: input.environment };
    const token = await this.tokenProvider(tokenScope);
    const baseUrl =
      input.environment === 'live'
        ? 'https://api-m.paypal.com'
        : 'https://api-m.sandbox.paypal.com';
    const response = await this.authorizedRequest(tokenScope, token, {
      method: 'POST',
      path: `${baseUrl}/v2/checkout/orders/${pathSegment(input.providerOrderId, 'providerOrderId')}/capture`,
      requestId: input.providerRequestId,
      preferRepresentation: true,
    });

    if (response.status >= 500 || response.status === 429) {
      throw {
        code: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
        message: 'PayPal capture returned an uncertain outcome',
        retryable: true,
        uncertain: true,
      };
    }

    if (response.status === 422) {
      const issueCodes = extractPaypalIssueCodes(response.body);
      if (issueCodes.includes('ORDER_ALREADY_CAPTURED')) {
        throw {
          code: PAYMENT_RELIABILITY_ERROR.PROVIDER_STATE_CONFLICT,
          message: 'PayPal order was already captured',
          retryable: false,
          uncertain: false,
        };
      }
      if (
        issueCodes.includes('ORDER_NOT_APPROVED') ||
        issueCodes.includes('PAYER_ACTION_REQUIRED')
      ) {
        throw {
          code: PAYMENT_RELIABILITY_ERROR.PROVIDER_ACTION_REQUIRED,
          message: 'PayPal order requires buyer approval before capture',
          retryable: false,
          uncertain: false,
        };
      }
      throw {
        code: PAYMENT_RELIABILITY_ERROR.PROVIDER_TERMINAL_REJECTION,
        message: 'PayPal rejected the capture request',
        retryable: false,
        uncertain: false,
      };
    }

    if (response.status >= 400) {
      throw {
        code: PAYMENT_RELIABILITY_ERROR.PROVIDER_TERMINAL_REJECTION,
        message: 'PayPal rejected the capture request',
        retryable: false,
        uncertain: false,
      };
    }

    return buildCaptureResultFromBody(response.body, input.providerOrderId, response.debugId);
  }

  private async createOrderWithExperienceContext(
    input: ExecuteCreateCheckoutOrderRequest,
  ): Promise<ExecuteCreateCheckoutOrderResult> {
    const tokenScope = { accountRef: input.accountRef, environment: input.environment };
    const token = await this.tokenProvider(tokenScope);
    const baseUrl =
      input.environment === 'live'
        ? 'https://api-m.paypal.com'
        : 'https://api-m.sandbox.paypal.com';
    const response = await this.authorizedRequest(tokenScope, token, {
      method: 'POST',
      path: `${baseUrl}/v2/checkout/orders`,
      requestId: input.providerRequestId,
      preferRepresentation: true,
      body: {
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: input.referenceId ?? undefined,
            amount: {
              currency_code: input.amount.currency,
              value: canonicalMoneyToLegacyMajorAmount(input.amount),
            },
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              user_action: 'PAY_NOW',
              ...(input.returnUrl ? { return_url: input.returnUrl } : {}),
              ...(input.cancelUrl ? { cancel_url: input.cancelUrl } : {}),
            },
          },
        },
      },
    });
    if (response.status >= 500 || response.status === 429) {
      throw {
        code: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
        message: 'PayPal order creation returned an uncertain outcome',
        retryable: true,
        uncertain: true,
      };
    }
    if (response.status >= 400 || !response.body['id']) {
      throw {
        code: PAYMENT_RELIABILITY_ERROR.PROVIDER_TERMINAL_REJECTION,
        message: 'PayPal rejected order creation',
        retryable: false,
        uncertain: false,
      };
    }
    const orderStatus = String(response.body['status'] ?? 'CREATED');
    return {
      providerOrderId: String(response.body['id']),
      checkoutStatus: resolveCheckoutStatusFromOrder(orderStatus, null),
      approvalUrl: extractPaypalCheckoutApprovalUrl(response.body['links'], input.environment),
      amount: input.amount,
      providerDebugId: response.debugId ?? null,
    };
  }

  async refundCapture(input: ExecuteRefundCaptureRequest): Promise<ExecuteRefundCaptureResult> {
    assertCapabilityReady(this.runtime.descriptor.capabilities, 'refund');
    const tokenScope = { accountRef: input.accountRef, environment: input.environment };
    const token = await this.tokenProvider(tokenScope);
    const baseUrl =
      input.environment === 'live'
        ? 'https://api-m.paypal.com'
        : 'https://api-m.sandbox.paypal.com';
    const body =
      input.amount != null
        ? {
            amount: {
              currency_code: input.amount.currency,
              value: canonicalMoneyToLegacyMajorAmount(input.amount),
            },
          }
        : undefined;

    const response = await this.authorizedRequest(tokenScope, token, {
      method: 'POST',
      path: `${baseUrl}/v2/payments/captures/${pathSegment(input.providerCaptureId, 'providerCaptureId')}/refund`,
      body,
      requestId: input.providerRequestId,
    });

    if (response.status === 404) {
      throw {
        code: PAYMENT_RELIABILITY_ERROR.PROVIDER_NOT_FOUND,
        message: 'PayPal capture was not found',
        retryable: false,
        uncertain: false,
      };
    }
    if (response.status >= 500 || response.status === 429) {
      throw {
        code: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
        message: 'PayPal refund returned uncertain outcome',
        retryable: true,
        uncertain: true,
      };
    }
    if (response.status >= 400) {
      throw {
        code: PAYMENT_RELIABILITY_ERROR.PROVIDER_TERMINAL_REJECTION,
        message: 'PayPal rejected the refund request',
        retryable: false,
        uncertain: false,
      };
    }

    const amountObj = response.body['amount'] as
      | { currency_code?: string; value?: string }
      | undefined;

    return {
      providerRefundId: String(response.body['id'] ?? 'refund-unknown'),
      refundStatus: mapRefundStatus(String(response.body['status'] ?? 'COMPLETED')),
      amount:
        amountObj?.currency_code && amountObj.value
          ? {
              currency: amountObj.currency_code,
              amountMinor: majorToMinor(amountObj.value, amountObj.currency_code),
            }
          : null,
      providerDebugId: response.debugId ?? null,
    };
  }

  async getRefund(input: ExecuteGetRefundRequest): Promise<ExecuteGetRefundResult> {
    assertCapabilityReady(this.runtime.descriptor.capabilities, 'refund');
    const tokenScope = { accountRef: input.accountRef, environment: input.environment };
    const token = await this.tokenProvider(tokenScope);
    const baseUrl =
      input.environment === 'live'
        ? 'https://api-m.paypal.com'
        : 'https://api-m.sandbox.paypal.com';
    const response = await this.authorizedRequest(tokenScope, token, {
      method: 'GET',
      path: `${baseUrl}/v2/payments/refunds/${pathSegment(input.providerRefundId, 'providerRefundId')}`,
    });

    if (response.status === 404) {
      throw {
        code: PAYMENT_RELIABILITY_ERROR.PROVIDER_NOT_FOUND,
        message: 'PayPal refund was not found',
        retryable: false,
        uncertain: false,
      };
    }
    if (response.status >= 500 || response.status === 429) {
      throw {
        code: PAYMENT_RELIABILITY_ERROR.PROVIDER_RETRYABLE,
        message: 'PayPal refund lookup failed',
        retryable: true,
        uncertain: true,
      };
    }
    if (response.status >= 400) {
      throw {
        code: PAYMENT_RELIABILITY_ERROR.PROVIDER_VALIDATION_REJECTION,
        message: 'PayPal refund lookup was rejected',
        retryable: false,
        uncertain: false,
      };
    }

    const amountObj = response.body['amount'] as
      | { currency_code?: string; value?: string }
      | undefined;

    return {
      providerRefundId: String(response.body['id'] ?? input.providerRefundId),
      refundStatus: mapRefundStatus(String(response.body['status'] ?? 'UNKNOWN')),
      amount:
        amountObj?.currency_code && amountObj.value
          ? {
              currency: amountObj.currency_code,
              amountMinor: majorToMinor(amountObj.value, amountObj.currency_code),
            }
          : null,
      providerDebugId: response.debugId ?? null,
    };
  }

  private async rejectUnconfigured(promise: Promise<unknown>): Promise<never> {
    try {
      await promise;
      throw new Error('Unexpected success from unconfigured fake');
    } catch (error) {
      if (isRecord(error) && error['code'] === PAYMENT_CAPABILITY_UNAVAILABLE) {
        throw error;
      }
      if (error instanceof PaymentError) {
        throw {
          code: PAYMENT_RELIABILITY_ERROR.PROVIDER_AUTH_FAILURE,
          message: 'Payment provider rejected authentication',
          causeCode: 'PROVIDER_AUTH_REJECTED',
          retryable: false,
          uncertain: false,
        };
      }
      throw error;
    }
  }
}
