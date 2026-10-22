import type { PaymentExecutionContext, PaymentExecutionRequest } from '../../contracts/index';

export function normalizeExecutionRequest<T>(payload: T | PaymentExecutionRequest<T>): {
  request: T;
  executionContext?: PaymentExecutionContext;
} {
  if (
    payload &&
    typeof payload === 'object' &&
    'request' in payload &&
    (payload as PaymentExecutionRequest<T>).request !== undefined
  ) {
    const envelope = payload as PaymentExecutionRequest<T>;
    return {
      request: envelope.request,
      executionContext: envelope.executionContext,
    };
  }

  return { request: payload as T };
}
