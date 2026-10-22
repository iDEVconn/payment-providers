export type PaypalOrdersHttpRequest = {
  method: 'GET' | 'POST';
  path: string;
  accessToken: string;
  body?: unknown;
  requestId?: string;
  attributionId?: string;
  preferRepresentation?: boolean;
};

export type PaypalOrdersHttpResponse = {
  status: number;
  body: Record<string, unknown>;
  debugId?: string | null;
};

export interface PaypalOrdersHttpClient {
  request(input: PaypalOrdersHttpRequest): Promise<PaypalOrdersHttpResponse>;
}
