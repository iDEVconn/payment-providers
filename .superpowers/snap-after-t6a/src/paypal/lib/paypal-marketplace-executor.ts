import {
  PAYMENT_RELIABILITY_ERROR,
  type ExecuteCaptureMarketplaceOrderRequest,
  type ExecuteCaptureMarketplaceOrderResult,
  type ExecuteCreateMarketplaceOrderRequest,
  type ExecuteCreateMarketplaceOrderResult,
  type ExecuteGetMarketplaceOrderRequest,
  type ExecuteGetMarketplaceOrderResult,
  type ExecuteGetRefundRequest,
  type ExecuteGetRefundResult,
  type ExecuteRefundMarketplaceUnitRequest,
  type ExecuteRefundMarketplaceUnitResult,
  type PaymentEnvironment,
} from '../../contracts/index';
import {
  assertCapabilityReady,
  pathSegment,
  minorUnitsToMajorString,
  parsePurchaseUnitsFromOrderBody,
  type MarketplaceProviderPort,
  type ResolvedPaymentRuntime,
} from '../../core/index';
import {
  resendWithFreshPaypalTokenOn401,
  type PaypalAccessTokenScope,
} from './paypal-access-token-retry';
import type { PaypalCheckoutTokenProvider } from './paypal-checkout-executor';
import { classifyPaypalMarketplaceCapture422 } from './paypal-marketplace-capture-policy';
import type {
  PaypalOrdersHttpClient,
  PaypalOrdersHttpRequest,
  PaypalOrdersHttpResponse,
} from './paypal-orders-http-client';

export type PaypalMarketplacePartnerConfig = {
  partnerAttributionId: string;
};

function baseUrl(environment: PaymentEnvironment): string {
  return environment === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

function extractApprovalUrl(links: unknown): string | null {
  if (!Array.isArray(links)) return null;
  const approve = links.find(
    (link) =>
      typeof link === 'object' &&
      link &&
      (link as { rel?: string }).rel === 'approve' &&
      typeof (link as { href?: string }).href === 'string',
  ) as { href?: string } | undefined;
  return approve?.href ?? null;
}

function majorToMinor(value: string, currency: string): string {
  const [whole = '0', fraction = ''] = value.split('.');
  const digits = currency === 'JPY' ? 0 : 2;
  const padded = fraction.padEnd(digits, '0').slice(0, digits);
  return `${whole}${padded}`.replace(/^0+(?=\d)/, '') || '0';
}

function mapRefundStatus(status: string): ExecuteRefundMarketplaceUnitResult['refundStatus'] {
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

function mapHttpError(response: { status: number; debugId?: string | null }, message: string) {
  if (response.status >= 500 || response.status === 429 || response.status === 504) {
    throw {
      code: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
      message,
      retryable: true,
      uncertain: true,
      providerDebugId: response.debugId ?? null,
    };
  }
  if (response.status === 401 || response.status === 403) {
    throw {
      code: PAYMENT_RELIABILITY_ERROR.PROVIDER_AUTH_FAILURE,
      message: 'PayPal marketplace authentication failed',
      retryable: false,
      uncertain: false,
      providerDebugId: response.debugId ?? null,
    };
  }
  if (response.status === 404) {
    throw {
      code: PAYMENT_RELIABILITY_ERROR.PROVIDER_NOT_FOUND,
      message: 'PayPal marketplace resource was not found',
      retryable: false,
      uncertain: false,
      providerDebugId: response.debugId ?? null,
    };
  }
  if (response.status >= 400) {
    throw {
      code: PAYMENT_RELIABILITY_ERROR.PROVIDER_TERMINAL_REJECTION,
      message,
      retryable: false,
      uncertain: response.status === 422,
      providerDebugId: response.debugId ?? null,
    };
  }
}

function buildPurchaseUnits(input: ExecuteCreateMarketplaceOrderRequest) {
  if (input.units.length < 1 || input.units.length > 10) {
    throw {
      code: PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
      message: 'Marketplace orders support 1 to 10 purchase units',
      retryable: false,
      uncertain: false,
    };
  }
  return input.units.map((unit) => ({
    reference_id: unit.referenceId,
    payee: { merchant_id: unit.providerMerchantId },
    amount: {
      currency_code: unit.amount.currency,
      value: minorUnitsToMajorString(unit.amount.amountMinor, unit.amount.currency),
    },
    payment_instruction: {
      disbursement_mode: 'INSTANT',
      ...(unit.platformFee
        ? {
            platform_fees: [
              {
                amount: {
                  currency_code: unit.platformFee.currency,
                  value: minorUnitsToMajorString(
                    unit.platformFee.amountMinor,
                    unit.platformFee.currency,
                  ),
                },
              },
            ],
          }
        : {}),
    },
  }));
}

function parseOrderResult(
  body: Record<string, unknown>,
  knownReferences: Map<string, { providerMerchantId: string | null }>,
): ExecuteGetMarketplaceOrderResult {
  const orderStatus = String(body['status'] ?? 'UNKNOWN');
  const units = parsePurchaseUnitsFromOrderBody(body, knownReferences);
  return {
    providerOrderId: String(body['id'] ?? ''),
    marketplaceStatus:
      orderStatus === 'PARTIALLY_COMPLETED'
        ? 'partially_captured'
        : orderStatus === 'COMPLETED'
          ? 'captured'
          : orderStatus === 'APPROVED'
            ? 'approved'
            : orderStatus === 'CREATED' || orderStatus === 'SAVED'
              ? 'created'
              : orderStatus === 'VOIDED'
                ? 'failed'
                : 'unknown',
    approvalUrl: extractApprovalUrl(body['links']),
    units,
    providerDebugId: null,
  };
}

export class PaypalMarketplaceExecutor implements MarketplaceProviderPort {
  constructor(
    private readonly runtime: ResolvedPaymentRuntime,
    private readonly httpClient: PaypalOrdersHttpClient,
    private readonly tokenProvider: PaypalCheckoutTokenProvider,
    private readonly partnerConfig: PaypalMarketplacePartnerConfig,
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
    input: ExecuteCreateMarketplaceOrderRequest,
  ): Promise<ExecuteCreateMarketplaceOrderResult> {
    assertCapabilityReady(this.runtime.descriptor.capabilities, 'marketplace_checkout');
    const tokenScope = { accountRef: input.accountRef, environment: input.environment };
    const token = await this.tokenProvider(tokenScope);
    const response = await this.authorizedRequest(tokenScope, token, {
      method: 'POST',
      path: `${baseUrl(input.environment)}/v2/checkout/orders`,
      attributionId: this.partnerConfig.partnerAttributionId,
      requestId: input.providerRequestId,
      body: {
        intent: 'CAPTURE',
        purchase_units: buildPurchaseUnits(input),
        application_context: {
          return_url: input.returnUrl ?? undefined,
          cancel_url: input.cancelUrl ?? undefined,
        },
      },
    });
    if (response.status >= 400) {
      mapHttpError(response, 'PayPal marketplace order create failed');
    }
    const known = new Map(
      input.units.map((unit) => [
        unit.referenceId,
        { providerMerchantId: unit.providerMerchantId },
      ]),
    );
    const parsed = parseOrderResult(response.body, known);
    return {
      providerOrderId: parsed.providerOrderId,
      marketplaceStatus: parsed.marketplaceStatus,
      approvalUrl: parsed.approvalUrl,
      units: parsed.units,
      providerDebugId: response.debugId ?? null,
    };
  }

  async getOrder(
    input: ExecuteGetMarketplaceOrderRequest,
  ): Promise<ExecuteGetMarketplaceOrderResult> {
    assertCapabilityReady(this.runtime.descriptor.capabilities, 'marketplace_checkout');
    const tokenScope = { accountRef: input.accountRef, environment: input.environment };
    const token = await this.tokenProvider(tokenScope);
    const response = await this.authorizedRequest(tokenScope, token, {
      method: 'GET',
      path: `${baseUrl(input.environment)}/v2/checkout/orders/${pathSegment(input.providerOrderId, 'providerOrderId')}`,
      attributionId: this.partnerConfig.partnerAttributionId,
    });
    if (response.status === 404) {
      throw {
        code: PAYMENT_RELIABILITY_ERROR.PROVIDER_NOT_FOUND,
        message: 'PayPal marketplace order was not found',
        retryable: false,
        uncertain: false,
      };
    }
    if (response.status >= 500 || response.status === 429) {
      throw {
        code: PAYMENT_RELIABILITY_ERROR.PROVIDER_RETRYABLE,
        message: 'PayPal marketplace order lookup failed',
        retryable: true,
        uncertain: true,
      };
    }
    if (response.status >= 400) {
      mapHttpError(response, 'PayPal marketplace order lookup rejected');
    }
    return {
      ...parseOrderResult(response.body, new Map()),
      providerDebugId: response.debugId ?? null,
    };
  }

  async captureOrder(
    input: ExecuteCaptureMarketplaceOrderRequest,
  ): Promise<ExecuteCaptureMarketplaceOrderResult> {
    assertCapabilityReady(this.runtime.descriptor.capabilities, 'marketplace_checkout');
    const tokenScope = { accountRef: input.accountRef, environment: input.environment };
    const token = await this.tokenProvider(tokenScope);
    const response = await this.authorizedRequest(tokenScope, token, {
      method: 'POST',
      path: `${baseUrl(input.environment)}/v2/checkout/orders/${pathSegment(input.providerOrderId, 'providerOrderId')}/capture`,
      attributionId: this.partnerConfig.partnerAttributionId,
      requestId: input.providerRequestId,
      body: {},
    });
    if (response.status === 504 || response.status >= 500) {
      throw {
        code: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
        message: 'PayPal marketplace capture returned uncertain outcome',
        retryable: true,
        uncertain: true,
        providerDebugId: response.debugId ?? null,
      };
    }
    if (response.status === 422) {
      const classification = classifyPaypalMarketplaceCapture422(response.body);
      if (classification.kind === 'terminal_pre_capture') {
        throw {
          code: PAYMENT_RELIABILITY_ERROR.PROVIDER_TERMINAL_REJECTION,
          message: 'PayPal marketplace capture was rejected before capture ids were issued',
          retryable: false,
          uncertain: false,
          providerDebugId: response.debugId ?? null,
        };
      }
      if (classification.kind === 'uncertain') {
        throw {
          code: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
          message: 'PayPal marketplace capture returned uncertain 422 outcome',
          retryable: true,
          uncertain: true,
          providerDebugId: response.debugId ?? null,
        };
      }
    }
    if (response.status >= 400 && response.status !== 207) {
      mapHttpError(response, 'PayPal marketplace capture failed');
    }
    const parsed = parseOrderResult(response.body, new Map());
    return {
      providerOrderId: parsed.providerOrderId || input.providerOrderId,
      marketplaceStatus: parsed.marketplaceStatus,
      units: parsed.units,
      httpStatus: response.status,
      providerDebugId: response.debugId ?? null,
    };
  }

  async refundUnit(
    input: ExecuteRefundMarketplaceUnitRequest,
  ): Promise<ExecuteRefundMarketplaceUnitResult> {
    assertCapabilityReady(this.runtime.descriptor.capabilities, 'marketplace_checkout');
    const tokenScope = { accountRef: input.accountRef, environment: input.environment };
    const token = await this.tokenProvider(tokenScope);
    const body: Record<string, unknown> = {};
    if (input.amount) {
      body['amount'] = {
        currency_code: input.amount.currency,
        value: minorUnitsToMajorString(input.amount.amountMinor, input.amount.currency),
      };
    }
    if (input.platformFeeRefund) {
      body['payment_instruction'] = {
        platform_fees: [
          {
            amount: {
              currency_code: input.platformFeeRefund.currency,
              value: minorUnitsToMajorString(
                input.platformFeeRefund.amountMinor,
                input.platformFeeRefund.currency,
              ),
            },
          },
        ],
      };
    }
    const response = await this.authorizedRequest(tokenScope, token, {
      method: 'POST',
      path: `${baseUrl(input.environment)}/v2/payments/captures/${pathSegment(input.providerCaptureId, 'providerCaptureId')}/refund`,
      attributionId: this.partnerConfig.partnerAttributionId,
      requestId: input.providerRequestId,
      body: Object.keys(body).length > 0 ? body : undefined,
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
        message: 'PayPal marketplace refund returned uncertain outcome',
        retryable: true,
        uncertain: true,
      };
    }
    if (response.status >= 400) {
      mapHttpError(response, 'PayPal marketplace refund was rejected');
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
    assertCapabilityReady(this.runtime.descriptor.capabilities, 'marketplace_checkout');
    const tokenScope = { accountRef: input.accountRef, environment: input.environment };
    const token = await this.tokenProvider(tokenScope);
    const response = await this.authorizedRequest(tokenScope, token, {
      method: 'GET',
      path: `${baseUrl(input.environment)}/v2/payments/refunds/${pathSegment(input.providerRefundId, 'providerRefundId')}`,
      attributionId: this.partnerConfig.partnerAttributionId,
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
      mapHttpError(response, 'PayPal refund lookup was rejected');
    }
    const amountObj = response.body['amount'] as
      | { currency_code?: string; value?: string }
      | undefined;
    return {
      providerRefundId: input.providerRefundId,
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
}
