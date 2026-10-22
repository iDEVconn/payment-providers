import { PAYMENT_RELIABILITY_ERROR } from '../../contracts/index';
import { ScopedTokenCacheRegistry, type TokenCacheScopeInput } from '../../core/index';

const DEFAULT_SAFETY_MARGIN_MS = 60_000;

export type PaypalOAuthCredentials = {
  clientId: string;
  clientSecret: string;
  environment: 'sandbox' | 'live';
  requestTimeoutMs?: number;
};

export type PaypalOAuthHttpClient = {
  postForm(
    url: string,
    body: URLSearchParams,
    headers: Record<string, string>,
    timeoutMs: number,
  ): Promise<{ status: number; body: Record<string, unknown>; debugId?: string | null }>;
};

type CachedToken = {
  token: string;
  expiresAt: number;
};

type ScopeState = {
  cached: CachedToken | null;
  inflight: Promise<string> | null;
};

export type PaypalAccessTokenRequestOptions = {
  /**
   * Token that PayPal just answered with HTTP 401. It is evicted from the cache (only if it is still
   * the cached one) so the next call fetches a fresh token; concurrent callers share one refresh.
   */
  rejectedToken?: string;
};

export class PaypalOAuthClient {
  private readonly registry = new ScopedTokenCacheRegistry<ScopeState>();

  constructor(
    private readonly credentialsByScope: (
      scope: TokenCacheScopeInput,
    ) => PaypalOAuthCredentials | null,
    private readonly http: PaypalOAuthHttpClient,
    private readonly safetyMarginMs = DEFAULT_SAFETY_MARGIN_MS,
  ) {}

  async getAccessToken(
    scope: TokenCacheScopeInput,
    options?: PaypalAccessTokenRequestOptions,
  ): Promise<string> {
    const credentials = this.credentialsByScope(scope);
    if (!credentials) {
      throw {
        code: PAYMENT_RELIABILITY_ERROR.PROVIDER_AUTH_FAILURE,
        message: 'PayPal OAuth credentials are not configured',
        retryable: false,
        uncertain: false,
      };
    }

    const state = this.registry.get({ ...scope, clientId: credentials.clientId }, () => ({
      cached: null,
      inflight: null,
    }));
    if (options?.rejectedToken !== undefined && state.cached?.token === options.rejectedToken) {
      state.cached = null;
    }
    if (state.cached && state.cached.expiresAt > Date.now()) {
      return state.cached.token;
    }
    if (state.inflight) {
      return state.inflight;
    }

    state.inflight = this.refresh(credentials, state);
    try {
      return await state.inflight;
    } finally {
      state.inflight = null;
    }
  }

  private async refresh(credentials: PaypalOAuthCredentials, state: ScopeState): Promise<string> {
    const baseUrl =
      credentials.environment === 'live'
        ? 'https://api-m.paypal.com'
        : 'https://api-m.sandbox.paypal.com';
    const body = new URLSearchParams({ grant_type: 'client_credentials' });
    const auth = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString(
      'base64',
    );
    const timeoutMs = credentials.requestTimeoutMs ?? 10_000;

    const response = await this.http.postForm(
      `${baseUrl}/v1/oauth2/token`,
      body,
      {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeoutMs,
    );

    if (response.status === 401 || response.status === 403) {
      throw {
        code: PAYMENT_RELIABILITY_ERROR.PROVIDER_AUTH_FAILURE,
        message: 'PayPal OAuth authentication failed',
        retryable: false,
        uncertain: false,
        providerDebugId: response.debugId ?? null,
      };
    }
    if (response.status >= 500 || response.status === 429) {
      throw {
        code: PAYMENT_RELIABILITY_ERROR.PROVIDER_RETRYABLE,
        message: 'PayPal OAuth request failed',
        retryable: true,
        uncertain: true,
        providerDebugId: response.debugId ?? null,
      };
    }
    if (response.status >= 400) {
      throw {
        code: PAYMENT_RELIABILITY_ERROR.PROVIDER_VALIDATION_REJECTION,
        message: 'PayPal OAuth request was rejected',
        retryable: false,
        uncertain: false,
        providerDebugId: response.debugId ?? null,
      };
    }

    const accessToken = response.body['access_token'];
    const expiresIn = response.body['expires_in'];
    if (typeof accessToken !== 'string' || typeof expiresIn !== 'number') {
      throw {
        code: PAYMENT_RELIABILITY_ERROR.PROVIDER_AUTH_FAILURE,
        message: 'PayPal OAuth response was malformed',
        retryable: false,
        uncertain: false,
      };
    }

    const ttlMs = Math.max(0, expiresIn * 1000 - this.safetyMarginMs);
    state.cached = { token: accessToken, expiresAt: Date.now() + ttlMs };
    return accessToken;
  }
}
