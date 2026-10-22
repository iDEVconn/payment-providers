export type PaypalSellerOnboardingHttpRequest = {
  method: 'GET' | 'POST';
  path: string;
  accessToken: string;
  attributionId: string;
  requestId?: string | null;
  body?: Record<string, unknown>;
};

export type PaypalSellerOnboardingHttpResponse = {
  status: number;
  body: Record<string, unknown>;
  debugId?: string | null;
};

export type PaypalSellerOnboardingHttpClient = {
  request(input: PaypalSellerOnboardingHttpRequest): Promise<PaypalSellerOnboardingHttpResponse>;
};
