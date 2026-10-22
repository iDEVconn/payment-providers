import {
  PAYMENT_RELIABILITY_ERROR,
  type ExecuteCreateSellerReferralRequest,
  type ExecuteCreateSellerReferralResult,
  type ExecuteFindSellerMerchantRequest,
  type ExecuteFindSellerMerchantResult,
  type ExecuteGetSellerMerchantStatusRequest,
  type ExecuteGetSellerMerchantStatusResult,
  type ExecuteGetSellerReferralRequest,
  type ExecuteGetSellerReferralResult,
} from '../../contracts/index';
import {
  assertCapabilityReady,
  pathSegment,
  type ResolvedPaymentRuntime,
  type SellerOnboardingProviderPort,
} from '../../core/index';
import {
  resendWithFreshPaypalTokenOn401,
  type PaypalAccessTokenScope,
} from './paypal-access-token-retry';
import type { PaypalCheckoutTokenProvider } from './paypal-checkout-executor';
import type {
  PaypalSellerOnboardingHttpClient,
  PaypalSellerOnboardingHttpRequest,
  PaypalSellerOnboardingHttpResponse,
} from './paypal-seller-onboarding-http-client';

export type PaypalSellerOnboardingPartnerConfig = {
  partnerMerchantId: string;
  partnerAttributionId: string;
  returnUrl: string;
  products: string[];
  features: string[];
};

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
      message: 'PayPal seller onboarding authentication failed',
      retryable: false,
      uncertain: false,
      providerDebugId: response.debugId ?? null,
    };
  }
  if (response.status === 404) {
    throw {
      code: PAYMENT_RELIABILITY_ERROR.PROVIDER_NOT_FOUND,
      message: 'PayPal seller onboarding resource was not found',
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

function hrefForRel(body: Record<string, unknown>, rel: string): string | null {
  const links = Array.isArray(body['links']) ? body['links'] : [];
  for (const link of links) {
    if (
      link &&
      typeof link === 'object' &&
      'rel' in link &&
      (link as { rel?: string }).rel === rel
    ) {
      const href = (link as { href?: string }).href;
      return typeof href === 'string' ? href : null;
    }
  }
  return null;
}

function referralIdFromSelf(body: Record<string, unknown>): string | null {
  const self = hrefForRel(body, 'self');
  if (!self) {
    return null;
  }
  const parts = self.split('/');
  return parts[parts.length - 1] || null;
}

export class PaypalSellerOnboardingExecutor implements SellerOnboardingProviderPort {
  constructor(
    private readonly runtime: ResolvedPaymentRuntime,
    private readonly httpClient: PaypalSellerOnboardingHttpClient,
    private readonly tokenProvider: PaypalCheckoutTokenProvider,
    private readonly partnerConfig: PaypalSellerOnboardingPartnerConfig,
  ) {}

  private authorizedRequest(
    scope: PaypalAccessTokenScope,
    token: string,
    request: Omit<PaypalSellerOnboardingHttpRequest, 'accessToken'>,
  ): Promise<PaypalSellerOnboardingHttpResponse> {
    return resendWithFreshPaypalTokenOn401(this.tokenProvider, scope, token, (accessToken) =>
      this.httpClient.request({ ...request, accessToken }),
    );
  }

  async createReferral(
    input: ExecuteCreateSellerReferralRequest,
  ): Promise<ExecuteCreateSellerReferralResult> {
    assertCapabilityReady(this.runtime.descriptor.capabilities, 'seller_onboarding');
    const tokenScope = { accountRef: input.accountRef, environment: input.environment };
    const token = await this.tokenProvider(tokenScope);
    const response = await this.authorizedRequest(tokenScope, token, {
      method: 'POST',
      path: `${baseUrl(input.environment)}/v2/customer/partner-referrals`,
      attributionId: this.partnerConfig.partnerAttributionId,
      requestId: input.providerRequestId,
      body: {
        tracking_id: input.trackingId,
        operations: [
          {
            operation: 'API_INTEGRATION',
            api_integration_preference: {
              rest_api_integration: {
                integration_method: 'PAYPAL',
                integration_type: 'THIRD_PARTY',
                third_party_details: {
                  features: this.partnerConfig.features,
                },
              },
            },
          },
        ],
        products: this.partnerConfig.products,
        legal_consents: [{ type: 'SHARE_DATA_CONSENT', granted: true }],
        partner_config_override: {
          return_url: this.partnerConfig.returnUrl,
        },
      },
    });
    if (response.status >= 400) {
      mapHttpError(response, 'PayPal partner referral create failed');
    }
    const providerReferralId = referralIdFromSelf(response.body) ?? 'unknown-referral';
    return {
      providerReferralId,
      actionUrl: hrefForRel(response.body, 'action_url'),
      providerDebugId: response.debugId ?? null,
    };
  }

  async getReferral(
    input: ExecuteGetSellerReferralRequest,
  ): Promise<ExecuteGetSellerReferralResult> {
    assertCapabilityReady(this.runtime.descriptor.capabilities, 'seller_onboarding');
    const tokenScope = { accountRef: input.accountRef, environment: input.environment };
    const token = await this.tokenProvider(tokenScope);
    const response = await this.authorizedRequest(tokenScope, token, {
      method: 'GET',
      path: `${baseUrl(input.environment)}/v2/customer/partner-referrals/${pathSegment(input.providerReferralId, 'providerReferralId')}`,
      attributionId: this.partnerConfig.partnerAttributionId,
    });
    if (response.status >= 400) {
      mapHttpError(response, 'PayPal partner referral get failed');
    }
    return {
      providerReferralId: input.providerReferralId,
      actionUrl: hrefForRel(response.body, 'action_url'),
      providerDebugId: response.debugId ?? null,
    };
  }

  async findMerchantByTrackingId(
    input: ExecuteFindSellerMerchantRequest,
  ): Promise<ExecuteFindSellerMerchantResult> {
    assertCapabilityReady(this.runtime.descriptor.capabilities, 'seller_onboarding');
    const tokenScope = { accountRef: input.accountRef, environment: input.environment };
    const token = await this.tokenProvider(tokenScope);
    const response = await this.authorizedRequest(tokenScope, token, {
      method: 'GET',
      path: `${baseUrl(input.environment)}/v1/customer/partners/${pathSegment(this.partnerConfig.partnerMerchantId, 'partnerMerchantId')}/merchant-integrations?tracking_id=${encodeURIComponent(input.trackingId)}`,
      attributionId: this.partnerConfig.partnerAttributionId,
    });
    if (response.status === 404) {
      return {
        providerMerchantId: null,
        trackingId: input.trackingId,
        providerDebugId: response.debugId ?? null,
      };
    }
    if (response.status >= 400) {
      mapHttpError(response, 'PayPal merchant tracking lookup failed');
    }
    const integrations = Array.isArray(response.body['items'])
      ? response.body['items']
      : Array.isArray(response.body)
        ? response.body
        : null;
    if (integrations && integrations.length > 1) {
      return {
        providerMerchantId: null,
        trackingId: input.trackingId,
        matchCount: integrations.length,
        ambiguous: true,
        providerDebugId: response.debugId ?? null,
      };
    }
    const single = integrations?.[0] as Record<string, unknown> | undefined;
    const merchantId =
      typeof single?.['merchant_id'] === 'string'
        ? single['merchant_id']
        : typeof response.body['merchant_id'] === 'string'
          ? response.body['merchant_id']
          : null;
    return {
      providerMerchantId: merchantId,
      trackingId: input.trackingId,
      matchCount: merchantId ? 1 : 0,
      ambiguous: false,
      providerDebugId: response.debugId ?? null,
    };
  }

  async getMerchantStatus(
    input: ExecuteGetSellerMerchantStatusRequest,
  ): Promise<ExecuteGetSellerMerchantStatusResult> {
    assertCapabilityReady(this.runtime.descriptor.capabilities, 'seller_onboarding');
    const tokenScope = { accountRef: input.accountRef, environment: input.environment };
    const token = await this.tokenProvider(tokenScope);
    const response = await this.authorizedRequest(tokenScope, token, {
      method: 'GET',
      path: `${baseUrl(input.environment)}/v1/customer/partners/${pathSegment(this.partnerConfig.partnerMerchantId, 'partnerMerchantId')}/merchant-integrations/${pathSegment(input.providerMerchantId, 'providerMerchantId')}`,
      attributionId: this.partnerConfig.partnerAttributionId,
    });
    if (response.status >= 400) {
      mapHttpError(response, 'PayPal merchant status get failed');
    }
    const oauth = Array.isArray(response.body['oauth_integrations'])
      ? response.body['oauth_integrations']
      : [];
    const scopes: string[] = [];
    let consentPresent = false;
    for (const integration of oauth) {
      if (!integration || typeof integration !== 'object') {
        continue;
      }
      const third = (integration as { oauth_third_party?: unknown }).oauth_third_party;
      if (!Array.isArray(third)) {
        continue;
      }
      for (const party of third) {
        if (party && typeof party === 'object') {
          consentPresent = true;
          const partyScopes = (party as { scopes?: unknown }).scopes;
          if (Array.isArray(partyScopes)) {
            for (const scope of partyScopes) {
              if (typeof scope === 'string') {
                scopes.push(scope);
              }
            }
          }
        }
      }
    }
    const products = Array.isArray(response.body['products']) ? response.body['products'] : [];
    const productActive = products.some(
      (product) =>
        product &&
        typeof product === 'object' &&
        (product as { status?: string }).status === 'ACTIVE',
    );
    const limitations = Array.isArray(response.body['limitations'])
      ? response.body['limitations']
      : [];
    return {
      providerMerchantId:
        typeof response.body['merchant_id'] === 'string'
          ? response.body['merchant_id']
          : input.providerMerchantId,
      trackingId:
        typeof response.body['tracking_id'] === 'string' ? response.body['tracking_id'] : null,
      paymentsReceivable:
        typeof response.body['payments_receivable'] === 'boolean'
          ? response.body['payments_receivable']
          : null,
      primaryEmailConfirmed:
        typeof response.body['primary_email_confirmed'] === 'boolean'
          ? response.body['primary_email_confirmed']
          : null,
      grantedScopes: scopes,
      productActive: products.length === 0 ? null : productActive,
      hasLimitations: limitations.length > 0,
      consentPresent,
      providerDebugId: response.debugId ?? null,
    };
  }
}
