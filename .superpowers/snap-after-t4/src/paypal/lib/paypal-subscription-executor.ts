import {
  PAYMENT_RELIABILITY_ERROR,
  type BillingCycleInput,
  type ExecuteCreateBillingPlanRequest,
  type ExecuteCreateBillingPlanResult,
  type ExecuteCreateCatalogProductRequest,
  type ExecuteCreateCatalogProductResult,
  type ExecuteCreateSubscriptionRequest,
  type ExecuteCreateSubscriptionResult,
  type ExecuteGetBillingPlanRequest,
  type ExecuteGetBillingPlanResult,
  type ExecuteGetCatalogProductRequest,
  type ExecuteGetCatalogProductResult,
  type ExecuteGetSubscriptionRequest,
  type ExecuteGetSubscriptionResult,
  type ExecutePlanLifecycleRequest,
  type ExecutePlanLifecycleResult,
  type ExecuteSubscriptionLifecycleRequest,
  type ExecuteSubscriptionLifecycleResult,
} from '../../contracts/index';
import {
  assertCapabilityReady,
  pathSegment,
  canonicalMoneyToLegacyMajorAmount,
  type SubscriptionProviderPort,
  type ResolvedPaymentRuntime,
} from '../../core/index';
import {
  mapPaypalPlanStatus,
  mapPaypalProductStatus,
  mapPaypalSubscriptionStatus,
} from '../../core/index';
import {
  resendWithFreshPaypalTokenOn401,
  type PaypalAccessTokenScope,
} from './paypal-access-token-retry';
import type { PaypalCheckoutTokenProvider } from './paypal-checkout-executor';
import type {
  PaypalSubscriptionHttpClient,
  PaypalSubscriptionHttpRequest,
  PaypalSubscriptionHttpResponse,
} from './paypal-subscription-http-client';

function baseUrl(environment: 'sandbox' | 'live'): string {
  return environment === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

function parsePaypalSubscriptionBodyStateTimestamp(body: Record<string, unknown>): string | null {
  const candidate = body['update_time'] ?? body['create_time'];
  if (typeof candidate !== 'string' || candidate.trim().length === 0) {
    return null;
  }
  const epochMs = Date.parse(candidate);
  if (Number.isNaN(epochMs)) {
    return null;
  }
  return new Date(epochMs).toISOString();
}

function mapHttpError(response: { status: number; debugId?: string | null }, message: string) {
  if (response.status >= 500 || response.status === 429) {
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
      message: 'PayPal subscription authentication failed',
      retryable: false,
      uncertain: false,
      providerDebugId: response.debugId ?? null,
    };
  }
  if (response.status === 404) {
    throw {
      code: PAYMENT_RELIABILITY_ERROR.PROVIDER_NOT_FOUND,
      message: 'PayPal subscription resource was not found',
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
      uncertain: false,
      providerDebugId: response.debugId ?? null,
    };
  }
}

function mapBillingCycles(cycles: BillingCycleInput[]) {
  return cycles.map((cycle) => ({
    tenure_type: cycle.tenureType,
    sequence: cycle.sequence,
    total_cycles: cycle.totalCycles,
    frequency: {
      interval_unit: cycle.intervalUnit,
      interval_count: cycle.intervalCount,
    },
    pricing_scheme: cycle.price
      ? {
          fixed_price: {
            currency_code: cycle.price.currency,
            value: canonicalMoneyToLegacyMajorAmount(cycle.price, {
              allowZero: cycle.tenureType === 'TRIAL',
            }),
          },
        }
      : undefined,
  }));
}

function requireProviderResourceId(
  value: unknown,
  message: string,
  providerDebugId: string | null | undefined,
): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) {
    throw {
      code: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
      message,
      retryable: true,
      uncertain: true,
      providerDebugId: providerDebugId ?? null,
    };
  }
  return trimmed;
}

/**
 * Digital buyers are never asked for a shipping address: `NO_SHIPPING` is the default unless
 * the caller chose a preference or the plan's product is physical.
 */
function resolveShippingPreference(input: ExecuteCreateSubscriptionRequest): string | undefined {
  if (input.shippingPreference) {
    return input.shippingPreference;
  }
  return input.productType === 'PHYSICAL' ? undefined : 'NO_SHIPPING';
}

function extractApproveUrl(body: Record<string, unknown>): string | null {
  const links = Array.isArray(body['links'])
    ? (body['links'] as Array<Record<string, unknown>>)
    : [];
  const approve = links.find((link) => link['rel'] === 'approve');
  return approve?.['href'] ? String(approve['href']) : null;
}

export class PaypalSubscriptionExecutor implements SubscriptionProviderPort {
  constructor(
    private readonly runtime: ResolvedPaymentRuntime,
    private readonly httpClient: PaypalSubscriptionHttpClient,
    private readonly tokenProvider: PaypalCheckoutTokenProvider,
  ) {}

  private authorizedRequest(
    scope: PaypalAccessTokenScope,
    token: string,
    request: Omit<PaypalSubscriptionHttpRequest, 'accessToken'>,
  ): Promise<PaypalSubscriptionHttpResponse> {
    return resendWithFreshPaypalTokenOn401(this.tokenProvider, scope, token, (accessToken) =>
      this.httpClient.request({ ...request, accessToken }),
    );
  }

  async createProduct(
    input: ExecuteCreateCatalogProductRequest,
  ): Promise<ExecuteCreateCatalogProductResult> {
    assertCapabilityReady(this.runtime.descriptor.capabilities, 'subscription');
    const tokenScope = { accountRef: input.accountRef, environment: input.environment };
    const token = await this.tokenProvider(tokenScope);
    const response = await this.authorizedRequest(tokenScope, token, {
      method: 'POST',
      path: `${baseUrl(input.environment)}/v1/catalogs/products`,
      requestId: input.providerRequestId,
      body: {
        name: input.name,
        description: input.description ?? undefined,
        type: input.type,
        category: input.category ?? undefined,
        home_url: input.homeUrl ?? undefined,
        image_url: input.imageUrl ?? undefined,
      },
    });
    mapHttpError(response, 'PayPal rejected catalog product creation');
    return {
      providerProductId: requireProviderResourceId(
        response.body['id'],
        'PayPal catalog product response did not include a provider id',
        response.debugId,
      ),
      productStatus: mapPaypalProductStatus(),
      providerDebugId: response.debugId ?? null,
    };
  }

  async getProduct(
    input: ExecuteGetCatalogProductRequest,
  ): Promise<ExecuteGetCatalogProductResult> {
    assertCapabilityReady(this.runtime.descriptor.capabilities, 'subscription');
    const tokenScope = { accountRef: input.accountRef, environment: input.environment };
    const token = await this.tokenProvider(tokenScope);
    const response = await this.authorizedRequest(tokenScope, token, {
      method: 'GET',
      path: `${baseUrl(input.environment)}/v1/catalogs/products/${pathSegment(input.providerProductId, 'providerProductId')}`,
    });
    mapHttpError(response, 'PayPal catalog product lookup failed');
    return {
      providerProductId: input.providerProductId,
      name: String(response.body['name'] ?? ''),
      type: (response.body['type'] as ExecuteGetCatalogProductResult['type']) ?? 'SERVICE',
      productStatus: mapPaypalProductStatus(),
      providerDebugId: response.debugId ?? null,
    };
  }

  async createPlan(
    input: ExecuteCreateBillingPlanRequest,
  ): Promise<ExecuteCreateBillingPlanResult> {
    assertCapabilityReady(this.runtime.descriptor.capabilities, 'subscription');
    const tokenScope = { accountRef: input.accountRef, environment: input.environment };
    const token = await this.tokenProvider(tokenScope);
    const response = await this.authorizedRequest(tokenScope, token, {
      method: 'POST',
      path: `${baseUrl(input.environment)}/v1/billing/plans`,
      requestId: input.providerRequestId,
      body: {
        product_id: input.providerProductId,
        name: input.name,
        description: input.description ?? undefined,
        status: input.status ?? 'CREATED',
        billing_cycles: mapBillingCycles(input.billingCycles),
        payment_preferences: {
          auto_bill_outstanding: input.paymentPreferences.autoBillOutstanding ?? true,
          setup_fee: input.paymentPreferences.setupFee
            ? {
                currency_code: input.paymentPreferences.setupFee.currency,
                value: canonicalMoneyToLegacyMajorAmount(input.paymentPreferences.setupFee),
              }
            : undefined,
          setup_fee_failure_action: input.paymentPreferences.setupFeeFailureAction ?? undefined,
          payment_failure_threshold: input.paymentPreferences.paymentFailureThreshold ?? undefined,
        },
        merchant_preferences: {
          return_url: input.returnUrl ?? undefined,
          cancel_url: input.cancelUrl ?? undefined,
        },
      },
    });
    mapHttpError(response, 'PayPal rejected billing plan creation');
    return {
      providerPlanId: requireProviderResourceId(
        response.body['id'],
        'PayPal billing plan response did not include a provider id',
        response.debugId,
      ),
      providerProductId: input.providerProductId,
      planStatus: mapPaypalPlanStatus(String(response.body['status'] ?? 'CREATED')),
      providerDebugId: response.debugId ?? null,
    };
  }

  async getPlan(input: ExecuteGetBillingPlanRequest): Promise<ExecuteGetBillingPlanResult> {
    assertCapabilityReady(this.runtime.descriptor.capabilities, 'subscription');
    const tokenScope = { accountRef: input.accountRef, environment: input.environment };
    const token = await this.tokenProvider(tokenScope);
    const response = await this.authorizedRequest(tokenScope, token, {
      method: 'GET',
      path: `${baseUrl(input.environment)}/v1/billing/plans/${pathSegment(input.providerPlanId, 'providerPlanId')}`,
    });
    mapHttpError(response, 'PayPal billing plan lookup failed');
    return {
      providerPlanId: input.providerPlanId,
      providerProductId: response.body['product_id'] ? String(response.body['product_id']) : null,
      planStatus: mapPaypalPlanStatus(String(response.body['status'] ?? 'UNKNOWN')),
      name: response.body['name'] ? String(response.body['name']) : null,
      providerDebugId: response.debugId ?? null,
    };
  }

  async activatePlan(input: ExecutePlanLifecycleRequest): Promise<ExecutePlanLifecycleResult> {
    return this.planLifecycle(input, 'activate');
  }

  async deactivatePlan(input: ExecutePlanLifecycleRequest): Promise<ExecutePlanLifecycleResult> {
    return this.planLifecycle(input, 'deactivate');
  }

  async createSubscription(
    input: ExecuteCreateSubscriptionRequest,
  ): Promise<ExecuteCreateSubscriptionResult> {
    assertCapabilityReady(this.runtime.descriptor.capabilities, 'subscription');
    const tokenScope = { accountRef: input.accountRef, environment: input.environment };
    const token = await this.tokenProvider(tokenScope);
    const response = await this.authorizedRequest(tokenScope, token, {
      method: 'POST',
      path: `${baseUrl(input.environment)}/v1/billing/subscriptions`,
      requestId: input.providerRequestId,
      body: {
        plan_id: input.providerPlanId,
        subscriber: input.subscriberEmail ? { email_address: input.subscriberEmail } : undefined,
        custom_id: input.customId ?? undefined,
        application_context: {
          brand_name: input.brandName ?? undefined,
          user_action: input.userAction ?? undefined,
          shipping_preference: resolveShippingPreference(input),
          return_url: input.returnUrl ?? undefined,
          cancel_url: input.cancelUrl ?? undefined,
        },
      },
    });
    mapHttpError(response, 'PayPal rejected subscription creation');
    const billingInfo = response.body['billing_info'] as Record<string, unknown> | undefined;
    return {
      providerSubscriptionId: requireProviderResourceId(
        response.body['id'],
        'PayPal subscription response did not include a provider id',
        response.debugId,
      ),
      providerPlanId: input.providerPlanId,
      subscriptionStatus: mapPaypalSubscriptionStatus(
        String(response.body['status'] ?? 'APPROVAL_PENDING'),
      ),
      approvalUrl: extractApproveUrl(response.body),
      startTime: response.body['start_time'] ? String(response.body['start_time']) : null,
      nextBillingTime: billingInfo?.['next_billing_time']
        ? String(billingInfo['next_billing_time'])
        : null,
      providerDebugId: response.debugId ?? null,
    };
  }

  async getSubscription(
    input: ExecuteGetSubscriptionRequest,
  ): Promise<ExecuteGetSubscriptionResult> {
    assertCapabilityReady(this.runtime.descriptor.capabilities, 'subscription');
    const tokenScope = { accountRef: input.accountRef, environment: input.environment };
    const token = await this.tokenProvider(tokenScope);
    const response = await this.authorizedRequest(tokenScope, token, {
      method: 'GET',
      path: `${baseUrl(input.environment)}/v1/billing/subscriptions/${pathSegment(input.providerSubscriptionId, 'providerSubscriptionId')}`,
    });
    mapHttpError(response, 'PayPal subscription lookup failed');
    const billingInfo = response.body['billing_info'] as Record<string, unknown> | undefined;
    return {
      providerSubscriptionId: input.providerSubscriptionId,
      providerPlanId: response.body['plan_id'] ? String(response.body['plan_id']) : null,
      subscriptionStatus: mapPaypalSubscriptionStatus(String(response.body['status'] ?? 'UNKNOWN')),
      approvalUrl: extractApproveUrl(response.body),
      startTime: response.body['start_time'] ? String(response.body['start_time']) : null,
      nextBillingTime: billingInfo?.['next_billing_time']
        ? String(billingInfo['next_billing_time'])
        : null,
      lifecycleReason: null,
      providerDebugId: response.debugId ?? null,
      providerSubscriptionStateAt: parsePaypalSubscriptionBodyStateTimestamp(response.body),
    };
  }

  async cancelSubscription(
    input: ExecuteSubscriptionLifecycleRequest,
  ): Promise<ExecuteSubscriptionLifecycleResult> {
    return this.subscriptionLifecycle(input, 'cancel');
  }

  async suspendSubscription(
    input: ExecuteSubscriptionLifecycleRequest,
  ): Promise<ExecuteSubscriptionLifecycleResult> {
    return this.subscriptionLifecycle(input, 'suspend');
  }

  async activateSubscription(
    input: ExecuteSubscriptionLifecycleRequest,
  ): Promise<ExecuteSubscriptionLifecycleResult> {
    return this.subscriptionLifecycle(input, 'activate');
  }

  private async planLifecycle(
    input: ExecutePlanLifecycleRequest,
    action: 'activate' | 'deactivate',
  ): Promise<ExecutePlanLifecycleResult> {
    assertCapabilityReady(this.runtime.descriptor.capabilities, 'subscription');
    const tokenScope = { accountRef: input.accountRef, environment: input.environment };
    const token = await this.tokenProvider(tokenScope);
    const response = await this.authorizedRequest(tokenScope, token, {
      method: 'POST',
      path: `${baseUrl(input.environment)}/v1/billing/plans/${pathSegment(input.providerPlanId, 'providerPlanId')}/${action}`,
      body: {},
    });
    mapHttpError(response, `PayPal billing plan ${action} failed`);
    if (response.status === 204) {
      return this.getPlan(input);
    }
    return {
      providerPlanId: input.providerPlanId,
      providerProductId: response.body['product_id'] ? String(response.body['product_id']) : null,
      planStatus: mapPaypalPlanStatus(
        action === 'activate' ? 'ACTIVE' : String(response.body['status'] ?? 'INACTIVE'),
      ),
      name: response.body['name'] ? String(response.body['name']) : null,
      providerDebugId: response.debugId ?? null,
    };
  }

  private async subscriptionLifecycle(
    input: ExecuteSubscriptionLifecycleRequest,
    action: 'cancel' | 'suspend' | 'activate',
  ): Promise<ExecuteSubscriptionLifecycleResult> {
    assertCapabilityReady(this.runtime.descriptor.capabilities, 'subscription');
    const tokenScope = { accountRef: input.accountRef, environment: input.environment };
    const token = await this.tokenProvider(tokenScope);
    const response = await this.authorizedRequest(tokenScope, token, {
      method: 'POST',
      path: `${baseUrl(input.environment)}/v1/billing/subscriptions/${pathSegment(input.providerSubscriptionId, 'providerSubscriptionId')}/${action}`,
      body: { reason: input.reason },
    });
    mapHttpError(response, `PayPal subscription ${action} failed`);
    try {
      const refreshed = await this.getSubscription({
        providerCode: input.providerCode,
        accountRef: input.accountRef,
        applicationRef: input.applicationRef,
        environment: input.environment,
        providerSubscriptionId: input.providerSubscriptionId,
      });
      return {
        ...refreshed,
        lifecycleReason: input.reason,
      };
    } catch (error) {
      const err = error as { code?: string; providerDebugId?: string | null };
      return {
        providerSubscriptionId: input.providerSubscriptionId,
        subscriptionStateRefreshPending: true,
        subscriptionStateRefreshErrorCode:
          err?.code ?? PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
        lifecycleReason: input.reason,
        providerDebugId: err?.providerDebugId ?? response.debugId ?? null,
      };
    }
  }
}
