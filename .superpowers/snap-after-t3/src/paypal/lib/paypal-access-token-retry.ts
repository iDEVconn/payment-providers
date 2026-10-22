import { PAYMENT_RELIABILITY_ERROR, type PaymentEnvironment } from '../../contracts/index';
import type { PaypalAccessTokenRequestOptions } from './paypal-oauth-client';

export type PaypalAccessTokenScope = {
  accountRef: string;
  environment: PaymentEnvironment;
};

export type PaypalAccessTokenProvider = (
  scope: PaypalAccessTokenScope,
  options?: PaypalAccessTokenRequestOptions,
) => Promise<string>;

/**
 * Sends one PayPal call with `token`. On HTTP 401 the token is reported as rejected (the OAuth client
 * evicts it; concurrent callers share one refresh) and the call is sent once more with the fresh
 * token. A second 401 is a non-retryable `PROVIDER_AUTH_FAILURE`. PayPal rejects a bad token before it
 * processes the request, and every mutating call carries `PayPal-Request-Id`, so the single resend is
 * safe. Tokens never appear in the thrown error.
 */
export async function resendWithFreshPaypalTokenOn401<
  T extends { status: number; debugId?: string | null },
>(
  tokenProvider: PaypalAccessTokenProvider,
  scope: PaypalAccessTokenScope,
  token: string,
  send: (accessToken: string) => Promise<T>,
): Promise<T> {
  const first = await send(token);
  if (first.status !== 401) {
    return first;
  }

  const freshToken = await tokenProvider(
    { accountRef: scope.accountRef, environment: scope.environment },
    { rejectedToken: token },
  );
  const second = await send(freshToken);
  if (second.status === 401) {
    throw {
      code: PAYMENT_RELIABILITY_ERROR.PROVIDER_AUTH_FAILURE,
      message: 'PayPal rejected the access token',
      retryable: false,
      uncertain: false,
      providerDebugId: second.debugId ?? null,
    };
  }
  return second;
}

/** Fetches a token, then sends the call with {@link resendWithFreshPaypalTokenOn401}. */
export async function sendWithPaypalAccessToken<
  T extends { status: number; debugId?: string | null },
>(
  tokenProvider: PaypalAccessTokenProvider,
  scope: PaypalAccessTokenScope,
  send: (accessToken: string) => Promise<T>,
): Promise<T> {
  const token = await tokenProvider({
    accountRef: scope.accountRef,
    environment: scope.environment,
  });
  return resendWithFreshPaypalTokenOn401(tokenProvider, scope, token, send);
}
