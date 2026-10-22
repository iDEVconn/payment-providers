import type {
  PaypalSellerOnboardingHttpClient,
  PaypalSellerOnboardingHttpRequest,
  PaypalSellerOnboardingHttpResponse,
} from './paypal-seller-onboarding-http-client';

/** Test/dev boundary. Never treat as Sandbox or Live provider evidence. */
export class FakePaypalSellerOnboardingHttpClient implements PaypalSellerOnboardingHttpClient {
  async request(
    input: PaypalSellerOnboardingHttpRequest,
  ): Promise<PaypalSellerOnboardingHttpResponse> {
    if (input.method === 'POST' && input.path.endsWith('/v2/customer/partner-referrals')) {
      return {
        status: 201,
        body: {
          links: [
            { rel: 'self', href: `${input.path}/FAKE-REF-1` },
            {
              rel: 'action_url',
              href: 'https://www.sandbox.paypal.com/bizsignup/partner/onboardingentry?token=fake',
            },
          ],
        },
        debugId: 'fake-debug',
      };
    }
    if (input.method === 'GET' && input.path.includes('/v2/customer/partner-referrals/')) {
      return {
        status: 200,
        body: {
          links: [
            {
              rel: 'action_url',
              href: 'https://www.sandbox.paypal.com/bizsignup/partner/onboardingentry?token=fake-refresh',
            },
          ],
        },
        debugId: 'fake-debug',
      };
    }
    if (
      input.method === 'GET' &&
      input.path.includes('/merchant-integrations') &&
      input.path.includes('tracking_id=')
    ) {
      return {
        status: 200,
        body: { merchant_id: 'FAKE-MERCHANT-1', tracking_id: 'seller-1' },
        debugId: 'fake-debug',
      };
    }
    if (input.method === 'GET' && input.path.includes('/merchant-integrations/')) {
      return {
        status: 200,
        body: {
          merchant_id: 'FAKE-MERCHANT-1',
          tracking_id: 'seller-1',
          payments_receivable: false,
          primary_email_confirmed: false,
          oauth_integrations: [],
          products: [{ name: 'EXPRESS_CHECKOUT', status: 'ACTIVE' }],
        },
        debugId: 'fake-debug',
      };
    }
    return { status: 404, body: {}, debugId: 'fake-debug' };
  }
}
