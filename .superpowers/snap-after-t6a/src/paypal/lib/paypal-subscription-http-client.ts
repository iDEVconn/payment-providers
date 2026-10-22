export type PaypalSubscriptionHttpRequest = {
  method: 'GET' | 'POST';
  path: string;
  accessToken: string;
  requestId?: string | null;
  body?: Record<string, unknown>;
};

export type PaypalSubscriptionHttpResponse = {
  status: number;
  body: Record<string, unknown>;
  debugId?: string | null;
};

export type PaypalSubscriptionHttpClient = {
  request(input: PaypalSubscriptionHttpRequest): Promise<PaypalSubscriptionHttpResponse>;
};
