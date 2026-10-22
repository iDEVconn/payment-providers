import { describe, expect, it, vi } from 'vitest';
import type {
  ExecuteCreateSubscriptionRequest,
  ExecuteCreateSubscriptionResult,
  PaymentOperation,
} from '../../../contracts/index';
import { buildOperationIdempotencyScope } from '../operation-idempotency';
import { MemoryPaymentReliabilityStore } from '../persistence/memory-payment-reliability-store';
import type { SubscriptionProviderPort } from '../subscription-provider-port';
import { SubscriptionLifecycleService } from '../subscription-lifecycle-service';

/*
 * Issue #22: a create retry that overlaps the still-in-flight original must not leave the operation
 * `unknown` without the PayPal subscription id. Ports probes p6 / p6b ("NEW retry concurrent with
 * in-flight original"): both calls use the same PayPal-Request-Id, so PayPal returns one
 * subscription; whichever call returns it persists it, and the other returns the stored result.
 */

const ctx = {
  providerCode: 'paypal',
  accountRef: 'default',
  applicationRef: 'app',
  environment: 'sandbox' as const,
};

const request = {
  ...ctx,
  idempotencyKey: 'k',
  providerPlanId: 'P-1',
  offeringRef: 'pro',
  subscriber: { subscriberRef: 'u1', email: 'a@b.c' },
};

const { idempotencyKey: _idempotencyKey, ...retryBase } = request;

const allowRetry = { evaluateProviderCreateRetryEligibility: () => 'allowed' as const };

type Pending = {
  input: ExecuteCreateSubscriptionRequest;
  resolve: (value: ExecuteCreateSubscriptionResult) => void;
  reject: (error: unknown) => void;
};

/** PayPal model: same PayPal-Request-Id -> same subscription. Each call waits until released. */
function controlledPaypal() {
  const calls: Pending[] = [];
  const byRequestId = new Map<string, string>();
  const createSubscription = vi.fn(
    (input: ExecuteCreateSubscriptionRequest) =>
      new Promise<ExecuteCreateSubscriptionResult>((resolve, reject) => {
        if (!byRequestId.has(input.providerRequestId)) {
          byRequestId.set(input.providerRequestId, `I-${byRequestId.size + 1}`);
        }
        calls.push({ input, resolve, reject });
      }),
  );
  const created = (index: number): ExecuteCreateSubscriptionResult => {
    const id = byRequestId.get(calls[index]?.input.providerRequestId ?? '') as string;
    return {
      providerSubscriptionId: id,
      providerPlanId: 'P-1',
      subscriptionStatus: 'approval_pending',
      approvalUrl: `https://paypal.test/approve/${id}`,
      startTime: null,
      nextBillingTime: null,
    };
  };
  const provider = {
    getPlan: vi.fn(async () => ({
      providerPlanId: 'P-1',
      providerProductId: 'PROD-1',
      planStatus: 'active' as const,
    })),
    createSubscription,
  } as unknown as SubscriptionProviderPort;
  return { provider, calls, byRequestId, created, createSubscription };
}

function timeout(): Error {
  return Object.assign(new Error('PayPal subscription HTTP request timed out'), {
    code: 'PROVIDER_UNCERTAIN',
    retryable: true,
    uncertain: true,
  });
}

async function startOriginalThenRetry() {
  const store = new MemoryPaymentReliabilityStore();
  const paypal = controlledPaypal();
  const service = new SubscriptionLifecycleService(store, paypal.provider);
  const original = service.createSubscription(request);
  await vi.waitFor(() => expect(paypal.calls.length).toBe(1));
  const operation = (await store.findOperationByIdempotency(
    buildOperationIdempotencyScope({ ...ctx, kind: 'subscription' }),
    'k',
  )) as PaymentOperation;
  expect(operation.status).toBe('submitted');
  const retry = service.retrySubscriptionCreate(
    { ...retryBase, subscriptionOperationId: operation.operationId },
    allowRetry,
  );
  await vi.waitFor(() => expect(paypal.calls.length).toBe(2));
  return { store, paypal, service, original, retry, operationId: operation.operationId };
}

describe('create retry overlapping the in-flight original (issue #22)', () => {
  it('original answers first: stored submitted with I-1 and the approval URL (probe p6)', async () => {
    const { store, paypal, service, original, retry, operationId } = await startOriginalThenRetry();
    paypal.calls[0]?.resolve(paypal.created(0));
    const originalResult = await original;
    paypal.calls[1]?.resolve(paypal.created(1));
    const retryResult = await retry;

    const stored = await store.findOperationById(operationId);
    expect(stored).toMatchObject({
      status: 'submitted',
      providerSubscriptionId: 'I-1',
      approvalUrl: 'https://paypal.test/approve/I-1',
      executionOwnerToken: null,
    });
    expect(originalResult.providerSubscriptionId).toBe('I-1');
    expect(retryResult.providerSubscriptionId).toBe('I-1');
    // One PayPal subscription, one PayPal-Request-Id.
    expect(new Set(paypal.byRequestId.values()).size).toBe(1);
    expect(paypal.calls.map((call) => call.input.providerRequestId)).toEqual([
      operationId,
      operationId,
    ]);

    // p6b: a further retry returns the stored subscription without another POST.
    const third = await service.retrySubscriptionCreate(
      { ...retryBase, subscriptionOperationId: operationId },
      allowRetry,
    );
    expect(third).toMatchObject({ operationStatus: 'submitted', providerSubscriptionId: 'I-1' });
    expect(paypal.createSubscription).toHaveBeenCalledTimes(2);
  });

  it('retry answers first: the original does not overwrite it', async () => {
    const { store, paypal, original, retry, operationId } = await startOriginalThenRetry();
    paypal.calls[1]?.resolve(paypal.created(1));
    expect((await retry).providerSubscriptionId).toBe('I-1');
    paypal.calls[0]?.resolve(paypal.created(0));
    expect((await original).providerSubscriptionId).toBe('I-1');

    expect(await store.findOperationById(operationId)).toMatchObject({
      status: 'submitted',
      providerSubscriptionId: 'I-1',
      approvalUrl: 'https://paypal.test/approve/I-1',
    });
  });

  it('original times out after the retry stored I-1: the timeout does not overwrite it', async () => {
    const { store, paypal, original, retry, operationId } = await startOriginalThenRetry();
    paypal.calls[1]?.resolve(paypal.created(1));
    await retry;
    paypal.calls[0]?.reject(timeout());
    expect((await original).providerSubscriptionId).toBe('I-1');
    expect(await store.findOperationById(operationId)).toMatchObject({
      status: 'submitted',
      providerSubscriptionId: 'I-1',
      failureCode: null,
    });
  });

  it('original times out while the retry is in flight: the retry still persists I-1', async () => {
    const { store, paypal, original, retry, operationId } = await startOriginalThenRetry();
    paypal.calls[0]?.reject(timeout());
    const originalResult = await original;
    expect(originalResult.providerSubscriptionId).toBe(null);
    expect(originalResult.operationStatus).toBe('submitted');
    paypal.calls[1]?.resolve(paypal.created(1));
    expect((await retry).providerSubscriptionId).toBe('I-1');
    expect(await store.findOperationById(operationId)).toMatchObject({
      status: 'submitted',
      providerSubscriptionId: 'I-1',
    });
  });

  it('the retry times out after the original stored I-1: the stored result stays', async () => {
    const { store, paypal, original, retry, operationId } = await startOriginalThenRetry();
    paypal.calls[0]?.resolve(paypal.created(0));
    await original;
    paypal.calls[1]?.reject(timeout());
    expect((await retry).providerSubscriptionId).toBe('I-1');
    expect(await store.findOperationById(operationId)).toMatchObject({
      status: 'submitted',
      providerSubscriptionId: 'I-1',
    });
  });

  // Review P4: PayPal may answer an overlapping call with a 4xx (request in progress, duplicate).
  it.each([409, 422])(
    'retry gets a terminal %i while the original is in flight: the original still stores I-1',
    async (status) => {
      const { store, paypal, original, retry, operationId } = await startOriginalThenRetry();
      paypal.calls[1]?.reject(
        Object.assign(new Error(`PayPal subscription create failed (${status})`), {
          code: 'PROVIDER_TERMINAL_REJECTION',
          retryable: false,
          uncertain: false,
        }),
      );
      const retryResult = await retry;
      expect(retryResult.operationStatus).toBe('unknown');
      paypal.calls[0]?.resolve(paypal.created(0));
      const originalResult = await original;

      expect(originalResult).toMatchObject({
        operationStatus: 'submitted',
        providerSubscriptionId: 'I-1',
        approvalUrl: 'https://paypal.test/approve/I-1',
      });
      expect(await store.findOperationById(operationId)).toMatchObject({
        status: 'submitted',
        providerSubscriptionId: 'I-1',
        approvalUrl: 'https://paypal.test/approve/I-1',
      });
      expect(new Set(paypal.byRequestId.values()).size).toBe(1);
    },
  );

  it('a terminal 4xx of a retry that overlaps nothing still fails the operation', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const paypal = controlledPaypal();
    const service = new SubscriptionLifecycleService(store, paypal.provider);
    const original = service.createSubscription(request);
    await vi.waitFor(() => expect(paypal.calls.length).toBe(1));
    paypal.calls[0]?.reject(timeout());
    const created = await original;
    expect(created.operationStatus).toBe('unknown');
    const retry = service.retrySubscriptionCreate(
      { ...retryBase, subscriptionOperationId: created.subscriptionOperationId },
      allowRetry,
    );
    await vi.waitFor(() => expect(paypal.calls.length).toBe(2));
    paypal.calls[1]?.reject(
      Object.assign(new Error('PayPal subscription create failed (422)'), {
        code: 'PROVIDER_TERMINAL_REJECTION',
        retryable: false,
        uncertain: false,
      }),
    );
    expect((await retry).operationStatus).toBe('failed');
  });

  it('two concurrent creates with one key: the claim loser returns the stored operation', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const paypal = controlledPaypal();
    const service = new SubscriptionLifecycleService(store, paypal.provider);
    const [first, second] = [
      service.createSubscription(request),
      service.createSubscription(request),
    ];
    await vi.waitFor(() => expect(paypal.calls.length).toBe(1));
    const loser = await Promise.race([first, second]);
    expect(loser).toMatchObject({ operationStatus: 'submitted', providerSubscriptionId: null });
    paypal.calls[0]?.resolve(paypal.created(0));
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.subscriptionOperationId)).toEqual([
      loser.subscriptionOperationId,
      loser.subscriptionOperationId,
    ]);
    expect(paypal.createSubscription).toHaveBeenCalledTimes(1);
    expect(await store.findOperationById(loser.subscriptionOperationId)).toMatchObject({
      status: 'submitted',
      providerSubscriptionId: 'I-1',
    });
  });
});
