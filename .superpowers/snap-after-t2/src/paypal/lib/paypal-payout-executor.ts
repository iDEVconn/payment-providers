import {
  PAYMENT_RELIABILITY_ERROR,
  type ExecuteCancelUnclaimedPayoutItemRequest,
  type ExecuteCancelUnclaimedPayoutItemResult,
  type ExecuteGetPayoutBatchRequest,
  type ExecuteGetPayoutBatchResult,
  type ExecuteGetPayoutItemRequest,
  type ExecuteGetPayoutItemResult,
  type ExecuteSubmitPayoutBatchRequest,
  type ExecuteSubmitPayoutBatchResult,
  type PayoutFinancialStatus,
} from '../../contracts/index';
import {
  assertCapabilityReady,
  pathSegment,
  canonicalMoneyToLegacyMajorAmount,
  PAYPAL_SENDER_BATCH_ID_MAX,
  PAYPAL_SENDER_ITEM_ID_MAX,
  type PayoutProviderPort,
  type ResolvedPaymentRuntime,
} from '../../core/index';
import { mapPaypalBatchStatus, mapPaypalItemTransactionStatus } from '../../core/index';
import { extractPaypalIssueCodes } from './paypal-checkout-order-parsing';
import type { PaypalCheckoutTokenProvider } from './paypal-checkout-executor';
import type { PaypalPayoutHttpClient } from './paypal-payout-http-client';

function majorToMinor(value: string, currency: string): string {
  const [whole = '0', fraction = ''] = value.split('.');
  const digits = currency === 'JPY' ? 0 : 2;
  const padded = fraction.padEnd(digits, '0').slice(0, digits);
  return `${whole}${padded}`.replace(/^0+(?=\d)/, '') || '0';
}

function isDuplicateSenderBatch(body: Record<string, unknown>): boolean {
  const details = body['details'];
  if (!Array.isArray(details)) {
    return false;
  }
  return details.some((detail) => {
    if (!detail || typeof detail !== 'object') {
      return false;
    }
    const row = detail as Record<string, unknown>;
    const field = String(row['field'] ?? '').toUpperCase();
    const issue = String(row['issue'] ?? '');
    return field === 'SENDER_BATCH_ID' || /already exists|duplicate/i.test(issue);
  });
}

function duplicatePayoutBatchId(body: Record<string, unknown>): string | null {
  const header = body['batch_header'] as Record<string, unknown> | undefined;
  if (header?.['payout_batch_id']) {
    return String(header['payout_batch_id']);
  }
  const details = body['details'];
  if (!Array.isArray(details)) {
    return null;
  }
  for (const detail of details) {
    if (!detail || typeof detail !== 'object') {
      continue;
    }
    const links = (detail as Record<string, unknown>)['link'];
    const list = Array.isArray(links) ? links : [];
    for (const link of list) {
      if (!link || typeof link !== 'object') {
        continue;
      }
      const href = String((link as Record<string, unknown>)['href'] ?? '');
      const match = href.match(/\/v1\/payments\/payouts\/([^/?#]+)/);
      if (match?.[1] && !href.includes('/payouts-item/')) {
        return decodeURIComponent(match[1]);
      }
    }
  }
  return null;
}

function assertPayoutSenderIdLengths(input: ExecuteSubmitPayoutBatchRequest): void {
  if (input.senderBatchId.length > PAYPAL_SENDER_BATCH_ID_MAX) {
    throw {
      code: PAYMENT_RELIABILITY_ERROR.PROVIDER_VALIDATION_REJECTION,
      message: `sender_batch_id exceeds PayPal maximum length (${PAYPAL_SENDER_BATCH_ID_MAX})`,
      retryable: false,
      uncertain: false,
      providerDebugId: null,
    };
  }
  for (const item of input.items) {
    if (item.senderItemId.length > PAYPAL_SENDER_ITEM_ID_MAX) {
      throw {
        code: PAYMENT_RELIABILITY_ERROR.PROVIDER_VALIDATION_REJECTION,
        message: `sender_item_id exceeds PayPal maximum length (${PAYPAL_SENDER_ITEM_ID_MAX})`,
        retryable: false,
        uncertain: false,
        providerDebugId: null,
      };
    }
  }
}

function terminalPayoutRejectionMessage(body: Record<string, unknown>): string {
  const issues = extractPaypalIssueCodes(body);
  const name = typeof body['name'] === 'string' ? body['name'] : null;
  if (issues.length > 0) {
    return `PayPal rejected the payout batch request: ${issues.join(', ')}`;
  }
  if (name) {
    return `PayPal rejected the payout batch request: ${name}`;
  }
  return 'PayPal rejected the payout batch request';
}

function normalizePaypalCurrency(value: string | undefined): string | null {
  const normalized = value?.trim().toUpperCase() || null;
  return normalized;
}

function parseMoney(
  input: { currency?: string; currency_code?: string; value?: string } | undefined,
) {
  if (input == null) {
    return null;
  }

  const currency = normalizePaypalCurrency(input.currency);
  const currencyCode = normalizePaypalCurrency(input.currency_code);
  if (currency && currencyCode && currency !== currencyCode) {
    throw {
      code: PAYMENT_RELIABILITY_ERROR.PROVIDER_VALIDATION_REJECTION,
      message: 'PayPal payout amount has conflicting currency fields',
      retryable: false,
      uncertain: false,
    };
  }

  const resolvedCurrency = currency ?? currencyCode;
  const value = input.value?.trim();
  if (!resolvedCurrency || !value) {
    throw {
      code: PAYMENT_RELIABILITY_ERROR.PROVIDER_VALIDATION_REJECTION,
      message: 'PayPal payout amount is missing currency or value',
      retryable: false,
      uncertain: false,
    };
  }

  return {
    currency: resolvedCurrency,
    amountMinor: majorToMinor(value, resolvedCurrency),
  };
}

export class PaypalPayoutExecutor implements PayoutProviderPort {
  constructor(
    private readonly runtime: ResolvedPaymentRuntime,
    private readonly httpClient: PaypalPayoutHttpClient,
    private readonly tokenProvider: PaypalCheckoutTokenProvider,
  ) {}

  async submitBatch(
    input: ExecuteSubmitPayoutBatchRequest,
  ): Promise<ExecuteSubmitPayoutBatchResult> {
    assertCapabilityReady(this.runtime.descriptor.capabilities, 'payout');
    assertPayoutSenderIdLengths(input);
    const token = await this.tokenProvider({
      accountRef: input.accountRef,
      environment: input.environment,
    });
    const baseUrl =
      input.environment === 'live'
        ? 'https://api-m.paypal.com'
        : 'https://api-m.sandbox.paypal.com';

    const response = await this.httpClient.request({
      method: 'POST',
      path: `${baseUrl}/v1/payments/payouts`,
      accessToken: token,
      requestId: input.providerRequestId,
      body: {
        sender_batch_header: {
          sender_batch_id: input.senderBatchId,
          email_subject: input.emailSubject ?? undefined,
          email_message: input.emailMessage ?? undefined,
        },
        items: input.items.map((item) => ({
          recipient_type: item.recipientType,
          recipient_wallet: 'PAYPAL',
          amount: {
            currency: item.amount.currency,
            value: canonicalMoneyToLegacyMajorAmount(item.amount),
          },
          receiver: item.receiver,
          sender_item_id: item.senderItemId,
          note: item.note ?? undefined,
          purpose: item.purpose ?? undefined,
        })),
      },
    });

    if (response.status >= 400 && isDuplicateSenderBatch(response.body)) {
      const providerPayoutBatchId = duplicatePayoutBatchId(response.body);
      if (!providerPayoutBatchId) {
        throw {
          code: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
          message: 'PayPal reported a duplicate sender batch without a batch id',
          retryable: true,
          uncertain: true,
          providerDebugId: response.debugId ?? null,
        };
      }
      const existing = await this.httpClient.request({
        method: 'GET',
        path: `${baseUrl}/v1/payments/payouts/${pathSegment(providerPayoutBatchId, 'providerPayoutBatchId')}`,
        accessToken: token,
      });
      if (existing.status >= 400) {
        throw {
          code: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
          message: 'PayPal duplicate sender batch could not be reconciled',
          retryable: true,
          uncertain: true,
          providerDebugId: existing.debugId ?? response.debugId ?? null,
        };
      }
      return this.mapAcceptedBatch(input, existing);
    }

    if (response.status >= 500 || response.status === 429) {
      throw {
        code: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
        message: 'PayPal payout submission returned uncertain outcome',
        retryable: true,
        uncertain: true,
        providerDebugId: response.debugId ?? null,
      };
    }
    if (response.status === 401 || response.status === 403) {
      throw {
        code: PAYMENT_RELIABILITY_ERROR.PROVIDER_AUTH_FAILURE,
        message: 'PayPal payout authentication failed',
        retryable: false,
        uncertain: false,
        providerDebugId: response.debugId ?? null,
      };
    }
    if (response.status >= 400) {
      throw {
        code: PAYMENT_RELIABILITY_ERROR.PROVIDER_TERMINAL_REJECTION,
        message: terminalPayoutRejectionMessage(response.body),
        retryable: false,
        uncertain: false,
        providerDebugId: response.debugId ?? null,
      };
    }

    return this.mapAcceptedBatch(input, response);
  }

  private mapAcceptedBatch(
    input: ExecuteSubmitPayoutBatchRequest,
    response: { body: Record<string, unknown>; debugId?: string | null },
  ): ExecuteSubmitPayoutBatchResult {
    const batchHeader = response.body['batch_header'] as Record<string, unknown> | undefined;
    const providerPayoutBatchId = String(batchHeader?.['payout_batch_id'] ?? 'unknown-batch');
    const batchPayoutStatus = mapPaypalBatchStatus(
      String(batchHeader?.['batch_status'] ?? 'PENDING'),
    );
    const responseItems = Array.isArray(response.body['items'])
      ? (response.body['items'] as Array<Record<string, unknown>>)
      : [];

    return {
      senderBatchId: input.senderBatchId,
      providerPayoutBatchId,
      batchPayoutStatus,
      items: input.items.map((item) => {
        const matched = responseItems.find((row) => {
          const payoutItem = row['payout_item'] as Record<string, unknown> | undefined;
          return payoutItem?.['sender_item_id'] === item.senderItemId;
        });
        const payoutStatus: PayoutFinancialStatus = matched
          ? mapPaypalItemTransactionStatus(String(matched['transaction_status'] ?? 'PENDING'))
          : 'pending';
        return {
          senderItemId: item.senderItemId,
          providerPayoutItemId: matched?.['payout_item_id']
            ? String(matched['payout_item_id'])
            : null,
          payoutStatus,
          providerTransactionId: null,
          providerFee: null,
          failureCode: null,
          failureMessage: null,
        };
      }),
      providerDebugId: response.debugId ?? null,
    };
  }

  async getBatch(input: ExecuteGetPayoutBatchRequest): Promise<ExecuteGetPayoutBatchResult> {
    assertCapabilityReady(this.runtime.descriptor.capabilities, 'payout');
    const token = await this.tokenProvider({
      accountRef: input.accountRef,
      environment: input.environment,
    });
    const baseUrl =
      input.environment === 'live'
        ? 'https://api-m.paypal.com'
        : 'https://api-m.sandbox.paypal.com';
    const response = await this.httpClient.request({
      method: 'GET',
      path: `${baseUrl}/v1/payments/payouts/${pathSegment(input.providerPayoutBatchId, 'providerPayoutBatchId')}`,
      accessToken: token,
    });
    return this.mapBatchLookup(response, input.providerPayoutBatchId);
  }

  async getItem(input: ExecuteGetPayoutItemRequest): Promise<ExecuteGetPayoutItemResult> {
    assertCapabilityReady(this.runtime.descriptor.capabilities, 'payout');
    const token = await this.tokenProvider({
      accountRef: input.accountRef,
      environment: input.environment,
    });
    const baseUrl =
      input.environment === 'live'
        ? 'https://api-m.paypal.com'
        : 'https://api-m.sandbox.paypal.com';
    const response = await this.httpClient.request({
      method: 'GET',
      path: `${baseUrl}/v1/payments/payouts-item/${pathSegment(input.providerPayoutItemId, 'providerPayoutItemId')}`,
      accessToken: token,
    });
    return this.mapItemLookup(response, input.providerPayoutItemId);
  }

  async cancelUnclaimedItem(
    input: ExecuteCancelUnclaimedPayoutItemRequest,
  ): Promise<ExecuteCancelUnclaimedPayoutItemResult> {
    assertCapabilityReady(this.runtime.descriptor.capabilities, 'payout');
    const token = await this.tokenProvider({
      accountRef: input.accountRef,
      environment: input.environment,
    });
    const baseUrl =
      input.environment === 'live'
        ? 'https://api-m.paypal.com'
        : 'https://api-m.sandbox.paypal.com';
    const response = await this.httpClient.request({
      method: 'POST',
      path: `${baseUrl}/v1/payments/payouts-item/${pathSegment(input.providerPayoutItemId, 'providerPayoutItemId')}/cancel`,
      accessToken: token,
      body: {},
    });
    if (response.status >= 400) {
      throw {
        code: PAYMENT_RELIABILITY_ERROR.PROVIDER_TERMINAL_REJECTION,
        message: 'PayPal rejected payout item cancellation',
        retryable: false,
        uncertain: false,
        providerDebugId: response.debugId ?? null,
      };
    }
    return this.mapItemLookup(response, input.providerPayoutItemId);
  }

  private mapBatchLookup(
    response: { status: number; body: Record<string, unknown>; debugId?: string | null },
    providerPayoutBatchId: string,
  ): ExecuteGetPayoutBatchResult {
    if (response.status === 404) {
      throw {
        code: PAYMENT_RELIABILITY_ERROR.PROVIDER_NOT_FOUND,
        message: 'PayPal payout batch was not found',
        retryable: false,
        uncertain: false,
      };
    }
    if (response.status >= 500) {
      throw {
        code: PAYMENT_RELIABILITY_ERROR.PROVIDER_RETRYABLE,
        message: 'PayPal payout batch lookup failed',
        retryable: true,
        uncertain: true,
      };
    }
    const batchHeader = response.body['batch_header'] as Record<string, unknown> | undefined;
    const items = Array.isArray(response.body['items'])
      ? (response.body['items'] as Array<Record<string, unknown>>)
      : [];
    return {
      providerPayoutBatchId,
      senderBatchId: batchHeader?.['sender_batch_header']
        ? String(
            (batchHeader['sender_batch_header'] as Record<string, unknown>)['sender_batch_id'] ??
              '',
          )
        : null,
      batchPayoutStatus: mapPaypalBatchStatus(String(batchHeader?.['batch_status'] ?? 'UNKNOWN')),
      items: items.map((row) => ({
        providerPayoutItemId: String(row['payout_item_id'] ?? ''),
        senderItemId: row['payout_item']
          ? String((row['payout_item'] as Record<string, unknown>)['sender_item_id'] ?? '')
          : null,
        payoutStatus: mapPaypalItemTransactionStatus(
          String(row['transaction_status'] ?? 'UNKNOWN'),
        ),
        amount: parseMoney(
          row['payout_item']
            ? ((row['payout_item'] as Record<string, unknown>)['amount'] as {
                currency?: string;
                currency_code?: string;
                value?: string;
              })
            : undefined,
        ),
        providerTransactionId: row['transaction_id'] ? String(row['transaction_id']) : null,
        providerFee: parseMoney(
          row['payout_item_fee'] as
            | { currency?: string; currency_code?: string; value?: string }
            | undefined,
        ),
        failureCode: null,
        failureMessage: null,
      })),
      providerDebugId: response.debugId ?? null,
    };
  }

  private mapItemLookup(
    response: { status: number; body: Record<string, unknown>; debugId?: string | null },
    providerPayoutItemId: string,
  ): ExecuteGetPayoutItemResult {
    if (response.status === 404) {
      throw {
        code: PAYMENT_RELIABILITY_ERROR.PROVIDER_NOT_FOUND,
        message: 'PayPal payout item was not found',
        retryable: false,
        uncertain: false,
      };
    }
    if (response.status >= 500) {
      throw {
        code: PAYMENT_RELIABILITY_ERROR.PROVIDER_RETRYABLE,
        message: 'PayPal payout item lookup failed',
        retryable: true,
        uncertain: true,
      };
    }
    const errors = response.body['errors'] as Record<string, unknown> | undefined;
    return {
      providerPayoutItemId,
      providerPayoutBatchId: response.body['payout_batch_id']
        ? String(response.body['payout_batch_id'])
        : null,
      senderBatchId: response.body['sender_batch_id']
        ? String(response.body['sender_batch_id'])
        : null,
      senderItemId: response.body['payout_item']
        ? String((response.body['payout_item'] as Record<string, unknown>)['sender_item_id'] ?? '')
        : null,
      payoutStatus: mapPaypalItemTransactionStatus(
        String(response.body['transaction_status'] ?? 'UNKNOWN'),
      ),
      amount: parseMoney(
        response.body['payout_item']
          ? ((response.body['payout_item'] as Record<string, unknown>)['amount'] as {
              currency?: string;
              currency_code?: string;
              value?: string;
            })
          : undefined,
      ),
      providerTransactionId: response.body['transaction_id']
        ? String(response.body['transaction_id'])
        : null,
      providerFee: parseMoney(
        response.body['payout_item_fee'] as
          | { currency?: string; currency_code?: string; value?: string }
          | undefined,
      ),
      failureCode: errors?.['name'] ? String(errors['name']) : null,
      failureMessage: errors?.['message'] ? String(errors['message']) : null,
      providerDebugId: response.debugId ?? null,
    };
  }
}
