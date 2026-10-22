export type PaypalPayoutHttpRequest = {
  method: 'GET' | 'POST';
  path: string;
  accessToken: string;
  body?: Record<string, unknown>;
  requestId?: string;
};

export type PaypalPayoutHttpResponse = {
  status: number;
  body: Record<string, unknown>;
  debugId?: string | null;
};

export type PaypalPayoutHttpClient = {
  request(input: PaypalPayoutHttpRequest): Promise<PaypalPayoutHttpResponse>;
};
