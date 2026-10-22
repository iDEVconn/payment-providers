import type { PaymentEnvironment } from './capabilities';
import type { CanonicalMoney } from './money';
import type { PaymentOperationStatus } from './operations';

export type PayoutRecipientType = 'EMAIL' | 'PHONE' | 'PAYPAL_ID';

export type PayoutFinancialStatus =
  | 'accepted'
  | 'processing'
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'blocked'
  | 'held'
  | 'unclaimed'
  | 'returned'
  | 'refunded'
  | 'cancelled'
  | 'unknown';

export type PayoutProviderContext = {
  providerCode: string;
  accountRef: string;
  applicationRef: string;
  environment: PaymentEnvironment;
};

export type PayoutRecipientInput = {
  recipientType: PayoutRecipientType;
  /** Server-side only at submission; never echoed in public results or errors. */
  receiver: string;
  note?: string | null;
  purpose?: string | null;
};

export type SubmitPayoutBatchItemInput = {
  itemRef: string;
  amount: CanonicalMoney;
  recipient: PayoutRecipientInput;
};

export type SubmitPayoutBatchRequest = PayoutProviderContext & {
  idempotencyKey: string;
  correlationId?: string | null;
  emailSubject?: string | null;
  emailMessage?: string | null;
  items: SubmitPayoutBatchItemInput[];
};

export type PayoutBatchItemResult = {
  itemOperationId: string;
  itemRef: string;
  operationStatus: PaymentOperationStatus;
  payoutStatus: PayoutFinancialStatus;
  senderItemId: string;
  providerPayoutItemId: string | null;
  amount: CanonicalMoney;
  maskedDestination: string;
  providerTransactionId: string | null;
  providerFee: CanonicalMoney | null;
  failureCode: string | null;
  failureMessage: string | null;
};

export type SubmitPayoutBatchResult = {
  batchOperationId: string;
  operationStatus: PaymentOperationStatus;
  payoutStatus: PayoutFinancialStatus;
  senderBatchId: string;
  providerPayoutBatchId: string | null;
  itemCount: number;
  totalsByCurrency: Record<string, string>;
  items: PayoutBatchItemResult[];
  correlationId: string | null;
  providerDebugId?: string | null;
};

export type GetPayoutBatchRequest = PayoutProviderContext & {
  batchOperationId: string;
};

export type GetPayoutBatchResult = SubmitPayoutBatchResult;

export type GetPayoutItemRequest = PayoutProviderContext & {
  itemOperationId: string;
};

export type GetPayoutItemResult = PayoutBatchItemResult & {
  batchOperationId: string;
  senderBatchId: string;
  providerPayoutBatchId: string | null;
  correlationId: string | null;
};

export type CancelUnclaimedPayoutItemRequest = PayoutProviderContext & {
  itemOperationId: string;
};

export type CancelUnclaimedPayoutItemResult = GetPayoutItemResult;

/** Provider execution — no durable fields. */
export type ExecuteSubmitPayoutBatchRequest = PayoutProviderContext & {
  providerRequestId: string;
  senderBatchId: string;
  emailSubject?: string | null;
  emailMessage?: string | null;
  items: Array<{
    senderItemId: string;
    amount: CanonicalMoney;
    recipientType: PayoutRecipientType;
    receiver: string;
    note?: string | null;
    purpose?: string | null;
  }>;
};

export type ExecuteSubmitPayoutBatchResult = {
  senderBatchId: string;
  providerPayoutBatchId: string;
  batchPayoutStatus: PayoutFinancialStatus;
  items: Array<{
    senderItemId: string;
    providerPayoutItemId: string | null;
    payoutStatus: PayoutFinancialStatus;
    providerTransactionId: string | null;
    providerFee: CanonicalMoney | null;
    failureCode: string | null;
    failureMessage: string | null;
  }>;
  providerDebugId?: string | null;
};

export type ExecuteGetPayoutBatchRequest = PayoutProviderContext & {
  providerPayoutBatchId: string;
};

export type ExecuteGetPayoutBatchResult = {
  providerPayoutBatchId: string;
  senderBatchId: string | null;
  batchPayoutStatus: PayoutFinancialStatus;
  items: Array<{
    providerPayoutItemId: string;
    senderItemId: string | null;
    payoutStatus: PayoutFinancialStatus;
    amount: CanonicalMoney | null;
    providerTransactionId: string | null;
    providerFee: CanonicalMoney | null;
    failureCode: string | null;
    failureMessage: string | null;
  }>;
  providerDebugId?: string | null;
};

export type ExecuteGetPayoutItemRequest = PayoutProviderContext & {
  providerPayoutItemId: string;
};

export type ExecuteGetPayoutItemResult = {
  providerPayoutItemId: string;
  providerPayoutBatchId: string | null;
  senderBatchId: string | null;
  senderItemId: string | null;
  payoutStatus: PayoutFinancialStatus;
  amount: CanonicalMoney | null;
  providerTransactionId: string | null;
  providerFee: CanonicalMoney | null;
  failureCode: string | null;
  failureMessage: string | null;
  providerDebugId?: string | null;
};

export type ExecuteCancelUnclaimedPayoutItemRequest = PayoutProviderContext & {
  providerPayoutItemId: string;
};

export type ExecuteCancelUnclaimedPayoutItemResult = ExecuteGetPayoutItemResult;
