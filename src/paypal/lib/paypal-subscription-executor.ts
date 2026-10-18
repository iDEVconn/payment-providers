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
  canonicalMoneyToLegacyMajorAmount,
  type SubscriptionProviderPort,
  type ResolvedPaymentRuntime,
} from '../../core/index';
import {
  mapPaypalPlanStatus,
  mapPaypalProductStatus,
  mapPaypalSubscriptionStatus,
} from '../../core/index';
import type { PaypalCheckoutTokenProvider } from './paypal-checkout-executor';
import type { PaypalSubscriptionHttpClient } from './paypal-subscription-http-client';

function baseUrl(environment: 'sandbox' | 'live'): string {
  return environment === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
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
            value: canonicalMoneyToLegacyMajorAmount(cycle.price),
          },
        }
      : undefined,
  }));
}

function requireProviderResourceId(value: unknown, message: string): string {
  if (typeof value !== 'string') {
    throw {
      code: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
      message,
      retryable: true,
      uncertain: true,
    };
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw {
      code: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
      message,
      retryable: true,
      uncertain: true,
    };
  }
  return trimmed;
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

  async createProduct(
    input: ExecuteCreateCatalogProductRequest,
  ): Promise<ExecuteCreateCatalogProductResult> {
    assertCapabilityReady(this.runtime.descriptor.capabilities, 'subscription');
    const token = await this.tokenProvider({
      accountRef: input.accountRef,
      environment: input.environment,
    });
    const response = await this.httpClient.request({
      method: 'POST',
      path: `${baseUrl(input.environment)}/v1/catalogs/products`,
      accessToken: token,
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
      ),
      productStatus: mapPaypalProductStatus(),
      providerDebugId: response.debugId ?? null,
    };
  }

  async getProduct(
    input: ExecuteGetCatalogProductRequest,
  ): Promise<ExecuteGetCatalogProductResult> {
    assertCapabilityReady(this.runtime.descriptor.capabilities, 'subscription');
    const token = await this.tokenProvider({
      accountRef: input.accountRef,
      environment: input.environment,
    });
    const response = await this.httpClient.request({
      method: 'GET',
      path: `${baseUrl(input.environment)}/v1/catalogs/products/${input.providerProductId}`,
      accessToken: token,
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
    const token = await this.tokenProvider({
      accountRef: input.accountRef,
      environment: input.environment,
    });
    const response = await this.httpClient.request({
      method: 'POST',
      path: `${baseUrl(input.environment)}/v1/billing/plans`,
      accessToken: token,
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
      ),
      providerProductId: input.providerProductId,
      planStatus: mapPaypalPlanStatus(String(response.body['status'] ?? 'CREATED')),
      providerDebugId: response.debugId ?? null,
    };
  }

  async getPlan(input: ExecuteGetBillingPlanRequest): Promise<ExecuteGetBillingPlanResult> {
    assertCapabilityReady(this.runtime.descriptor.capabilities, 'subscription');
    const token = await this.tokenProvider({
      accountRef: input.accountRef,
      environment: input.environment,
    });
    const response = await this.httpClient.request({
      method: 'GET',
      path: `${baseUrl(input.environment)}/v1/billing/plans/${input.providerPlanId}`,
      accessToken: token,
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
    const token = await this.tokenProvider({
      accountRef: input.accountRef,
      environment: input.environment,
    });
    const response = await this.httpClient.request({
      method: 'POST',
      path: `${baseUrl(input.environment)}/v1/billing/subscriptions`,
      accessToken: token,
      requestId: input.providerRequestId,
      body: {
        plan_id: input.providerPlanId,
        subscriber: input.subscriberEmail ? { email_address: input.subscriberEmail } : undefined,
        application_context: {
          return_url: input.returnUrl ?? undefined,
          cancel_url: input.cancelUrl ?? undefined,
        },
      },
    });
    mapHttpError(response, 'PayPal rejected subscription creation');
    const billingInfo = response.body['billing_info'] as Record<string, unknown> | undefined;
    return {
      providerSubscriptionId: String(response.body['id'] ?? 'unknown-subscription'),
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
    const token = await this.tokenProvider({
      accountRef: input.accountRef,
      environment: input.environment,
    });
    const response = await this.httpClient.request({
      method: 'GET',
      path: `${baseUrl(input.environment)}/v1/billing/subscriptions/${input.providerSubscriptionId}`,
      accessToken: token,
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
    const token = await this.tokenProvider({
      accountRef: input.accountRef,
      environment: input.environment,
    });
    const response = await this.httpClient.request({
      method: 'POST',
      path: `${baseUrl(input.environment)}/v1/billing/plans/${input.providerPlanId}/${action}`,
      accessToken: token,
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
    const token = await this.tokenProvider({
      accountRef: input.accountRef,
      environment: input.environment,
    });
    const response = await this.httpClient.request({
      method: 'POST',
      path: `${baseUrl(input.environment)}/v1/billing/subscriptions/${input.providerSubscriptionId}/${action}`,
      accessToken: token,
      body: { reason: input.reason },
    });
    mapHttpError(response, `PayPal subscription ${action} failed`);
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
      lifecycleReason: input.reason,
      providerDebugId: response.debugId ?? null,
    };
  }
}
