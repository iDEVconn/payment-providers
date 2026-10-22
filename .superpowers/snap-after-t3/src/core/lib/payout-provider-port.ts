import type {
  ExecuteCancelUnclaimedPayoutItemRequest,
  ExecuteCancelUnclaimedPayoutItemResult,
  ExecuteGetPayoutBatchRequest,
  ExecuteGetPayoutBatchResult,
  ExecuteGetPayoutItemRequest,
  ExecuteGetPayoutItemResult,
  ExecuteSubmitPayoutBatchRequest,
  ExecuteSubmitPayoutBatchResult,
} from '../../contracts/index';

export type PayoutProviderExecutionError = {
  code: string;
  message: string;
  retryable: boolean;
  uncertain: boolean;
  providerDebugId?: string | null;
};

export type PayoutProviderPort = {
  submitBatch(input: ExecuteSubmitPayoutBatchRequest): Promise<ExecuteSubmitPayoutBatchResult>;
  getBatch(input: ExecuteGetPayoutBatchRequest): Promise<ExecuteGetPayoutBatchResult>;
  getItem(input: ExecuteGetPayoutItemRequest): Promise<ExecuteGetPayoutItemResult>;
  cancelUnclaimedItem(
    input: ExecuteCancelUnclaimedPayoutItemRequest,
  ): Promise<ExecuteCancelUnclaimedPayoutItemResult>;
};

export type PayoutReconciliationProviderLookup = Pick<PayoutProviderPort, 'getBatch' | 'getItem'>;
