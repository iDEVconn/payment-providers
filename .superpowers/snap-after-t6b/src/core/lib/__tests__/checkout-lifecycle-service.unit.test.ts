import { describe, expect, it, vi } from 'vitest';
import {
  PAYMENT_RELIABILITY_ERROR,
  PAYMENT_TRANSITION_REJECTION_REASON,
  PaymentReliabilityError,
} from '../../../contracts/index';
import { CHECKOUT_CREATE_EXECUTION_LEASE_MS } from '../checkout-create-execution-lease';
import type { CheckoutProviderPort } from '../checkout-provider-port';
import {
  CheckoutLifecycleService,
  type CheckoutCreateRetryOptions,
} from '../checkout-lifecycle-service';
import { buildCommandFingerprint } from '../command-fingerprint';
import { buildOperationIdempotencyScope } from '../operation-idempotency';
import { MemoryPaymentReliabilityStore } from '../persistence/memory-payment-reliability-store';

function fakeProvider(overrides: Partial<CheckoutProviderPort> = {}): CheckoutProviderPort {
  return {
    createOrder: vi.fn().mockResolvedValue({
      providerOrderId: 'order-1',
      checkoutStatus: 'created',
      approvalUrl: 'https://sandbox.paypal.com/approve/order-1',
      amount: { currency: 'USD', amountMinor: '999' },
    }),
    getOrder: vi.fn().mockResolvedValue({
      providerOrderId: 'order-1',
      checkoutStatus: 'approved',
      approvalUrl: null,
      amount: { currency: 'USD', amountMinor: '999' },
      captureAmount: null,
      providerCaptureId: null,
      providerCaptureStatus: null,
    }),
    captureOrder: vi.fn().mockResolvedValue({
      providerOrderId: 'order-1',
      providerCaptureId: 'capture-1',
      providerCaptureStatus: 'captured',
      captureStatus: 'captured',
      amount: { currency: 'USD', amountMinor: '999' },
    }),
    refundCapture: vi.fn().mockResolvedValue({
      providerRefundId: 'refund-1',
      refundStatus: 'completed',
      amount: { currency: 'USD', amountMinor: '999' },
    }),
    getRefund: vi.fn(),
    ...overrides,
  };
}

describe('CheckoutLifecycleService', () => {
  it('creates durable operation before provider mutation and preserves approval URL', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const provider = fakeProvider();
    const service = new CheckoutLifecycleService(store, provider);

    const result = await service.createCheckoutOrder({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      idempotencyKey: 'idem-1',
      amount: { currency: 'USD', amountMinor: '999' },
    });

    expect(result.approvalUrl).toBe('https://sandbox.paypal.com/approve/order-1');
    expect(result.providerOrderId).toBe('order-1');
    expect(provider.createOrder).toHaveBeenCalledTimes(1);
    const operation = await store.findOperationByProviderOrderId(
      'paypal',
      'default',
      'sandbox',
      'order-1',
    );
    expect(operation?.status).toBe('submitted');
  });

  it('reuses the same operation for repeated idempotent create', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const provider = fakeProvider();
    const service = new CheckoutLifecycleService(store, provider);
    const input = {
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox' as const,
      idempotencyKey: 'idem-2',
      amount: { currency: 'USD', amountMinor: '999' },
    };

    const first = await service.createCheckoutOrder(input);
    const second = await service.createCheckoutOrder(input);

    expect(first.operationId).toBe(second.operationId);
    expect(provider.createOrder).toHaveBeenCalledTimes(1);
  });

  it('rejects conflicting idempotency fingerprint', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const service = new CheckoutLifecycleService(store, fakeProvider());

    await service.createCheckoutOrder({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      idempotencyKey: 'idem-3',
      amount: { currency: 'USD', amountMinor: '999' },
    });

    await expect(
      service.createCheckoutOrder({
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'test-app',
        environment: 'sandbox',
        idempotencyKey: 'idem-3',
        amount: { currency: 'USD', amountMinor: '1000' },
      }),
    ).rejects.toBeInstanceOf(PaymentReliabilityError);
  });

  it('stores capture id without double-capturing on retry', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const provider = fakeProvider();
    const lifecycle = new CheckoutLifecycleService(store, provider);
    const checkout = await lifecycle.createCheckoutOrder({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      idempotencyKey: 'idem-4',
      amount: { currency: 'USD', amountMinor: '999' },
    });

    const captureInput = {
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox' as const,
      idempotencyKey: 'cap-1',
      checkoutOperationId: checkout.operationId,
      providerOrderId: checkout.providerOrderId ?? 'order-1',
    };

    const first = await lifecycle.captureCheckoutOrder(captureInput);
    const second = await lifecycle.captureCheckoutOrder(captureInput);

    expect(first.providerCaptureId).toBe('capture-1');
    expect(second.operationId).toBe(first.operationId);
    expect(provider.captureOrder).toHaveBeenCalledTimes(1);
  });

  it('rejects partial refunds that exceed remaining capture balance', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const provider = fakeProvider({
      captureOrder: vi.fn().mockResolvedValue({
        providerOrderId: 'order-1',
        providerCaptureId: 'capture-1',
        captureStatus: 'captured',
        amount: { currency: 'USD', amountMinor: '1000' },
      }),
    });
    const lifecycle = new CheckoutLifecycleService(store, provider);
    const checkout = await lifecycle.createCheckoutOrder({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      idempotencyKey: 'idem-refund-cap',
      amount: { currency: 'USD', amountMinor: '1000' },
    });
    const capture = await lifecycle.captureCheckoutOrder({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      idempotencyKey: 'cap-refund-cap',
      checkoutOperationId: checkout.operationId,
      providerOrderId: checkout.providerOrderId ?? 'order-1',
    });

    await lifecycle.refundCapture({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      idempotencyKey: 'refund-a',
      captureOperationId: capture.operationId,
      providerCaptureId: capture.providerCaptureId ?? 'capture-1',
      amount: { currency: 'USD', amountMinor: '700' },
    });

    await expect(
      lifecycle.refundCapture({
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'test-app',
        environment: 'sandbox',
        idempotencyKey: 'refund-b',
        captureOperationId: capture.operationId,
        providerCaptureId: capture.providerCaptureId ?? 'capture-1',
        amount: { currency: 'USD', amountMinor: '400' },
      }),
    ).rejects.toBeInstanceOf(PaymentReliabilityError);
  });

  it('marks pre-approval capture rejection as failed and creates one continuation child after approval', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const captureOrder = vi
      .fn()
      .mockRejectedValueOnce({
        code: PAYMENT_RELIABILITY_ERROR.PROVIDER_ACTION_REQUIRED,
        message: 'PayPal order requires buyer approval before capture',
        retryable: false,
        uncertain: false,
      })
      .mockResolvedValueOnce({
        providerOrderId: 'order-1',
        providerCaptureId: 'capture-approved-once',
        providerCaptureStatus: 'captured',
        captureStatus: 'captured',
        amount: { currency: 'USD', amountMinor: '999' },
      });
    const provider = fakeProvider({ captureOrder });
    const lifecycle = new CheckoutLifecycleService(store, provider);
    const checkout = await lifecycle.createCheckoutOrder({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      idempotencyKey: 'idem-continuation',
      amount: { currency: 'USD', amountMinor: '999' },
    });

    const captureInput = {
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox' as const,
      idempotencyKey: 'cap-parent',
      checkoutOperationId: checkout.operationId,
      providerOrderId: checkout.providerOrderId ?? 'order-1',
    };

    const rejected = await lifecycle.captureCheckoutOrder(captureInput);
    expect(rejected.captureStatus).toBe('created');
    expect(rejected.operationStatus).toBe('failed');

    const parent = await store.findOperationById(rejected.operationId);
    expect(parent?.status).toBe('failed');
    expect(parent?.failureCode).toBe(PAYMENT_RELIABILITY_ERROR.PROVIDER_ACTION_REQUIRED);

    const resumed = await lifecycle.captureCheckoutOrder(captureInput);
    expect(resumed.captureStatus).toBe('captured');
    expect(resumed.providerCaptureId).toBe('capture-approved-once');
    expect(resumed.operationId).not.toBe(rejected.operationId);
    expect(captureOrder).toHaveBeenCalledTimes(2);
    expect(captureOrder.mock.calls[1]?.[0]?.providerRequestId).toBe(resumed.operationId);

    const replay = await lifecycle.captureCheckoutOrder(captureInput);
    expect(replay.operationId).toBe(resumed.operationId);
    expect(captureOrder).toHaveBeenCalledTimes(2);

    const children = await store.listOperationsByParent(rejected.operationId);
    expect(children).toHaveLength(1);
    expect(children[0]?.operationId).toBe(resumed.operationId);
  });

  it('retries uncertain capture with the same operation id after unknown claim', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const captureOrder = vi
      .fn()
      .mockRejectedValueOnce({
        code: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
        message: 'PayPal capture returned an uncertain outcome',
        retryable: true,
        uncertain: true,
      })
      .mockResolvedValueOnce({
        providerOrderId: 'order-1',
        providerCaptureId: 'capture-same-id',
        providerCaptureStatus: 'captured',
        captureStatus: 'captured',
        amount: { currency: 'USD', amountMinor: '999' },
      });
    const provider = fakeProvider({ captureOrder });
    const lifecycle = new CheckoutLifecycleService(store, provider);
    const checkout = await lifecycle.createCheckoutOrder({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      idempotencyKey: 'idem-unknown-retry',
      amount: { currency: 'USD', amountMinor: '999' },
    });

    const captureInput = {
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox' as const,
      idempotencyKey: 'cap-unknown',
      checkoutOperationId: checkout.operationId,
      providerOrderId: checkout.providerOrderId ?? 'order-1',
    };

    const uncertain = await lifecycle.captureCheckoutOrder(captureInput);
    expect(uncertain.operationStatus).toBe('unknown');
    const operationId = uncertain.operationId;

    const retried = await lifecycle.captureCheckoutOrder(captureInput);
    expect(retried.operationId).toBe(operationId);
    expect(retried.captureStatus).toBe('captured');
    expect(captureOrder).toHaveBeenCalledTimes(2);
    expect(captureOrder.mock.calls[0]?.[0]?.providerRequestId).toBe(operationId);
    expect(captureOrder.mock.calls[1]?.[0]?.providerRequestId).toBe(operationId);

    const continuationRows = await store.listOperationsByParent(operationId);
    expect(continuationRows).toHaveLength(0);
  });

  it('allows only one unknown retry POST when two callers overlap', async () => {
    const store = new MemoryPaymentReliabilityStore();
    let releaseCapture: (() => void) | undefined;
    const captureGate = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    const captureOrder = vi
      .fn()
      .mockRejectedValueOnce({
        code: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
        message: 'PayPal capture returned an uncertain outcome',
        retryable: true,
        uncertain: true,
      })
      .mockImplementationOnce(async () => {
        await captureGate;
        return {
          providerOrderId: 'order-1',
          providerCaptureId: 'capture-single-post',
          providerCaptureStatus: 'captured',
          captureStatus: 'captured',
          amount: { currency: 'USD', amountMinor: '999' },
        };
      });
    const provider = fakeProvider({ captureOrder });
    const lifecycle = new CheckoutLifecycleService(store, provider);
    const checkout = await lifecycle.createCheckoutOrder({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      idempotencyKey: 'idem-overlap',
      amount: { currency: 'USD', amountMinor: '999' },
    });

    const captureInput = {
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox' as const,
      idempotencyKey: 'cap-overlap',
      checkoutOperationId: checkout.operationId,
      providerOrderId: checkout.providerOrderId ?? 'order-1',
    };

    await lifecycle.captureCheckoutOrder(captureInput);

    const firstRetry = lifecycle.captureCheckoutOrder(captureInput);
    const secondRetry = lifecycle.captureCheckoutOrder(captureInput);
    releaseCapture?.();
    const [first, second] = await Promise.all([firstRetry, secondRetry]);

    expect(captureOrder).toHaveBeenCalledTimes(2);
    expect([first.captureStatus, second.captureStatus]).toContain('captured');
    expect([first.captureStatus, second.captureStatus]).toContain('unknown');
  });

  it('reconciles completed capture using capture amount rather than purchase-unit amount', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const provider = fakeProvider({
      getOrder: vi.fn().mockResolvedValue({
        providerOrderId: 'order-1',
        checkoutStatus: 'captured',
        approvalUrl: null,
        amount: { currency: 'USD', amountMinor: '99999' },
        captureAmount: { currency: 'USD', amountMinor: '999' },
        providerCaptureId: 'capture-reconcile',
        providerCaptureStatus: 'captured',
      }),
      captureOrder: vi.fn(),
    });
    const lifecycle = new CheckoutLifecycleService(store, provider);
    const checkout = await lifecycle.createCheckoutOrder({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      idempotencyKey: 'idem-reconcile-amount',
      amount: { currency: 'USD', amountMinor: '999' },
    });

    const captured = await lifecycle.captureCheckoutOrder({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      idempotencyKey: 'cap-reconcile-amount',
      checkoutOperationId: checkout.operationId,
      providerOrderId: checkout.providerOrderId ?? 'order-1',
    });

    expect(captured.captureStatus).toBe('captured');
    expect(captured.providerCaptureId).toBe('capture-reconcile');
    expect(captured.amount).toEqual({ currency: 'USD', amountMinor: '999' });
    expect(provider.captureOrder).not.toHaveBeenCalled();
  });

  it('does not reconcile completed capture when capture amount is missing', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const provider = fakeProvider({
      getOrder: vi.fn().mockResolvedValue({
        providerOrderId: 'order-1',
        checkoutStatus: 'captured',
        approvalUrl: null,
        amount: { currency: 'USD', amountMinor: '999' },
        captureAmount: null,
        providerCaptureId: 'capture-no-amount',
        providerCaptureStatus: 'captured',
      }),
    });
    const lifecycle = new CheckoutLifecycleService(store, provider);
    const checkout = await lifecycle.createCheckoutOrder({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      idempotencyKey: 'idem-missing-capture-amount',
      amount: { currency: 'USD', amountMinor: '999' },
    });

    const captured = await lifecycle.captureCheckoutOrder({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      idempotencyKey: 'cap-missing-capture-amount',
      checkoutOperationId: checkout.operationId,
      providerOrderId: checkout.providerOrderId ?? 'order-1',
    });

    expect(captured.captureStatus).toBe('unknown');
    expect(captured.providerCaptureId).toBeNull();
  });

  it('returns pending when local persistence conflicts and the row has no provider order yet', async () => {
    const store = new MemoryPaymentReliabilityStore();
    const originalTransition = store.transitionOperation.bind(store);
    let transitionCalls = 0;
    store.transitionOperation = async (input) => {
      transitionCalls += 1;
      if (transitionCalls === 2) {
        throw new PaymentReliabilityError(
          PAYMENT_RELIABILITY_ERROR.TRANSITION_CONFLICT,
          'Simulated persistence failure',
        );
      }
      return originalTransition(input);
    };
    const provider = fakeProvider();
    const lifecycle = new CheckoutLifecycleService(store, provider);
    const result = await lifecycle.createCheckoutOrder({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox',
      idempotencyKey: 'idem-persist-fail',
      amount: { currency: 'USD', amountMinor: '999' },
    });

    expect(result.outcome).toBe('pending');
    expect(result.providerOrderId).toBeNull();
    expect(result.nextAction).toBe('check_status');
  });

  describe('checkout create executor persistence conflicts', () => {
    const scope = {
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox' as const,
    };
    const createInput = {
      ...scope,
      idempotencyKey: 'idem-exec-conflict',
      amount: { currency: 'USD', amountMinor: '999' },
    };

    it('returns the webhook-persisted checkout when persistence conflicts after provider create', async () => {
      const store = new MemoryPaymentReliabilityStore();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const provider = fakeProvider({
        createOrder: vi.fn().mockImplementation(async () => {
          await gate;
          return {
            providerOrderId: 'order-stale-executor',
            checkoutStatus: 'created' as const,
            approvalUrl: 'https://sandbox.paypal.com/approve/order-stale-executor',
            amount: { currency: 'USD', amountMinor: '999' },
          };
        }),
      });
      const lifecycle = new CheckoutLifecycleService(store, provider);
      const createPromise = lifecycle.createCheckoutOrder(createInput);

      await vi.waitFor(async () => {
        expect(provider.createOrder).toHaveBeenCalled();
      });

      const checkoutScope = buildOperationIdempotencyScope({
        applicationRef: scope.applicationRef,
        accountRef: scope.accountRef,
        environment: scope.environment,
        kind: 'checkout',
      });
      const inFlight = await store.findOperationByIdempotency(
        checkoutScope,
        createInput.idempotencyKey,
      );
      if (!inFlight) {
        throw new Error('expected in-flight checkout operation');
      }

      await store.transitionOperation({
        operationId: inFlight.operationId,
        expectedVersion: inFlight.version,
        nextStatus: 'submitted',
        providerOrderId: 'order-webhook',
        providerReferenceId: 'order-webhook',
        approvalUrl: 'https://sandbox.paypal.com/approve/order-webhook',
        executionOwnerToken: null,
        executionLeaseExpiresAt: null,
        reason: 'Simulated webhook reconciliation update',
      });

      release();
      const result = await createPromise;

      expect(result.providerOrderId).toBe('order-webhook');
      expect(result.outcome).toBe('requires_action');
      expect(result.approvalUrl).toBe('https://sandbox.paypal.com/approve/order-webhook');
    });

    it('does not apply a stale executor failure over a newer submitted checkout result', async () => {
      const store = new MemoryPaymentReliabilityStore();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const provider = fakeProvider({
        createOrder: vi.fn().mockImplementation(async () => {
          await gate;
          throw {
            code: PAYMENT_RELIABILITY_ERROR.PROVIDER_TERMINAL_REJECTION,
            message: 'PayPal rejected the order',
            retryable: false,
            uncertain: false,
          };
        }),
      });
      const lifecycle = new CheckoutLifecycleService(store, provider);
      const createPromise = lifecycle.createCheckoutOrder(createInput);

      await vi.waitFor(async () => {
        expect(provider.createOrder).toHaveBeenCalled();
      });

      const checkoutScope = buildOperationIdempotencyScope({
        applicationRef: scope.applicationRef,
        accountRef: scope.accountRef,
        environment: scope.environment,
        kind: 'checkout',
      });
      const inFlight = await store.findOperationByIdempotency(
        checkoutScope,
        createInput.idempotencyKey,
      );
      if (!inFlight) {
        throw new Error('expected in-flight checkout operation');
      }

      await store.transitionOperation({
        operationId: inFlight.operationId,
        expectedVersion: inFlight.version,
        nextStatus: 'submitted',
        providerOrderId: 'order-webhook',
        providerReferenceId: 'order-webhook',
        approvalUrl: 'https://sandbox.paypal.com/approve/order-webhook',
        executionOwnerToken: null,
        executionLeaseExpiresAt: null,
        reason: 'Simulated webhook success before stale failure persist',
      });

      release();
      const result = await createPromise;

      expect(result.outcome).toBe('requires_action');
      expect(result.providerOrderId).toBe('order-webhook');
      const persisted = await store.findOperationById(inFlight.operationId);
      expect(persisted?.status).toBe('submitted');
      expect(persisted?.failureCode).toBeNull();
    });

    it('returns the newer lease holder result when an old executor loses the owner token', async () => {
      const store = new MemoryPaymentReliabilityStore();
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const provider = fakeProvider({
        createOrder: vi.fn().mockImplementation(async () => {
          await firstGate;
          return {
            providerOrderId: 'order-first-executor',
            checkoutStatus: 'created' as const,
            approvalUrl: 'https://sandbox.paypal.com/approve/order-first-executor',
            amount: { currency: 'USD', amountMinor: '999' },
          };
        }),
      });
      const lifecycle = new CheckoutLifecycleService(store, provider);
      const alwaysAllowRetry: CheckoutCreateRetryOptions = {
        evaluateProviderCreateRetryEligibility: () => 'allowed',
      };

      provider.createOrder.mockRejectedValueOnce({
        code: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
        message: 'PayPal HTTP request timed out',
        retryable: true,
        uncertain: true,
      });
      const seeded = await lifecycle.createCheckoutOrder({
        ...createInput,
        idempotencyKey: 'idem-lease-owner-race',
      });
      expect(seeded.outcome).toBe('unknown');
      vi.mocked(provider.createOrder).mockClear();
      provider.createOrder.mockImplementation(async () => {
        await firstGate;
        return {
          providerOrderId: 'order-first-executor',
          checkoutStatus: 'created' as const,
          approvalUrl: 'https://sandbox.paypal.com/approve/order-first-executor',
          amount: { currency: 'USD', amountMinor: '999' },
        };
      });

      const retryPayload = {
        ...scope,
        checkoutOperationId: seeded.operationId,
        idempotencyKey: createInput.idempotencyKey,
        amount: createInput.amount,
      };

      const firstRetry = lifecycle.retryCheckoutOrder(retryPayload, alwaysAllowRetry);
      await vi.waitFor(() => {
        expect(provider.createOrder).toHaveBeenCalledTimes(1);
      });

      const inFlight = await store.findOperationById(seeded.operationId);
      if (!inFlight) {
        throw new Error('expected in-flight checkout operation');
      }

      await store.transitionOperation({
        operationId: inFlight.operationId,
        expectedVersion: inFlight.version,
        nextStatus: 'submitted',
        providerOrderId: 'order-second-executor',
        providerReferenceId: 'order-second-executor',
        approvalUrl: 'https://sandbox.paypal.com/approve/order-second-executor',
        executionOwnerToken: null,
        executionLeaseExpiresAt: null,
        reason: 'Simulated newer lease holder persistence',
      });

      releaseFirst();
      const firstResult = await firstRetry;

      expect(firstResult.providerOrderId).toBe('order-second-executor');
      expect(firstResult.approvalUrl).toBe(
        'https://sandbox.paypal.com/approve/order-second-executor',
      );
      expect(provider.createOrder).toHaveBeenCalledTimes(1);
    });

    it('surfaces non-conflict persistence failures from checkout create result writes', async () => {
      const store = new MemoryPaymentReliabilityStore();
      const originalTransition = store.transitionOperation.bind(store);
      store.transitionOperation = async (input) => {
        if (input.expectedExecutionOwnerToken) {
          throw new PaymentReliabilityError(
            PAYMENT_RELIABILITY_ERROR.PERSISTENCE_FAILURE,
            'Simulated durable store outage',
          );
        }
        return originalTransition(input);
      };
      const provider = fakeProvider();
      const lifecycle = new CheckoutLifecycleService(store, provider);

      await expect(lifecycle.createCheckoutOrder(createInput)).rejects.toMatchObject({
        code: PAYMENT_RELIABILITY_ERROR.PERSISTENCE_FAILURE,
      });
    });

    it('does not swallow invalid transition rejections from executor persistence', async () => {
      const store = new MemoryPaymentReliabilityStore();
      const originalTransition = store.transitionOperation.bind(store);
      store.transitionOperation = async (input) => {
        if (input.expectedExecutionOwnerToken) {
          throw new PaymentReliabilityError(
            PAYMENT_RELIABILITY_ERROR.TRANSITION_REJECTED,
            'Transition from "succeeded" to "unknown" is not allowed',
            { rejectionReason: PAYMENT_TRANSITION_REJECTION_REASON.INVALID_TRANSITION },
          );
        }
        return originalTransition(input);
      };
      const provider = fakeProvider();
      const lifecycle = new CheckoutLifecycleService(store, provider);

      await expect(lifecycle.createCheckoutOrder(createInput)).rejects.toMatchObject({
        code: PAYMENT_RELIABILITY_ERROR.TRANSITION_REJECTED,
        rejectionReason: PAYMENT_TRANSITION_REJECTION_REASON.INVALID_TRANSITION,
      });
    });

    it('does not treat transition rejected without rejectionReason as a concurrency conflict', async () => {
      const store = new MemoryPaymentReliabilityStore();
      const originalTransition = store.transitionOperation.bind(store);
      store.transitionOperation = async (input) => {
        if (input.expectedExecutionOwnerToken) {
          throw new PaymentReliabilityError(
            PAYMENT_RELIABILITY_ERROR.TRANSITION_REJECTED,
            'Operation transition rejected',
          );
        }
        return originalTransition(input);
      };
      const provider = fakeProvider();
      const lifecycle = new CheckoutLifecycleService(store, provider);

      await expect(lifecycle.createCheckoutOrder(createInput)).rejects.toMatchObject({
        code: PAYMENT_RELIABILITY_ERROR.TRANSITION_REJECTED,
      });
    });
  });

  describe('getCheckoutOrder', () => {
    const scope = {
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox' as const,
    };

    it('loads checkout by operation id, resolves provider order id, and calls provider GET', async () => {
      const store = new MemoryPaymentReliabilityStore();
      const provider = fakeProvider();
      const lifecycle = new CheckoutLifecycleService(store, provider);
      const checkout = await lifecycle.createCheckoutOrder({
        ...scope,
        idempotencyKey: 'idem-get-by-op',
        amount: { currency: 'USD', amountMinor: '999' },
      });

      vi.mocked(provider.getOrder).mockClear();
      vi.mocked(provider.createOrder).mockClear();
      vi.mocked(provider.captureOrder).mockClear();

      const result = await lifecycle.getCheckoutOrder({
        ...scope,
        checkoutOperationId: checkout.operationId,
      });

      expect(result.operationId).toBe(checkout.operationId);
      expect(result.providerOrderId).toBe('order-1');
      expect(provider.getOrder).toHaveBeenCalledTimes(1);
      expect(provider.getOrder).toHaveBeenCalledWith(
        expect.objectContaining({ providerOrderId: 'order-1' }),
      );
      expect(provider.createOrder).not.toHaveBeenCalled();
      expect(provider.captureOrder).not.toHaveBeenCalled();
    });

    it('returns unknown from stored operation without provider GET when provider order id is missing', async () => {
      const store = new MemoryPaymentReliabilityStore();
      const provider = fakeProvider();
      const lifecycle = new CheckoutLifecycleService(store, provider);
      const operation = await store.createOperation({
        idempotencyKey: 'idem-op-only',
        idempotencyScope: 'edc::default::sandbox::checkout',
        commandFingerprint: 'fp-op-only',
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'test-app',
        environment: 'sandbox',
        kind: 'checkout',
        amountMinor: '999',
        currencyCode: 'USD',
      });
      await store.transitionOperation({
        operationId: operation.operationId,
        expectedVersion: operation.version,
        nextStatus: 'unknown',
        reason: 'Provider create outcome uncertain',
      });

      vi.mocked(provider.getOrder).mockClear();

      const result = await lifecycle.getCheckoutOrder({
        ...scope,
        checkoutOperationId: operation.operationId,
      });

      expect(result.outcome).toBe('unknown');
      expect(result.operationId).toBe(operation.operationId);
      expect(provider.getOrder).not.toHaveBeenCalled();
      expect(provider.createOrder).not.toHaveBeenCalled();
      expect(provider.captureOrder).not.toHaveBeenCalled();
    });

    it('rejects non-checkout operation kind for operation id lookup', async () => {
      const store = new MemoryPaymentReliabilityStore();
      const lifecycle = new CheckoutLifecycleService(store, fakeProvider());
      const checkout = await lifecycle.createCheckoutOrder({
        ...scope,
        idempotencyKey: 'idem-wrong-kind',
        amount: { currency: 'USD', amountMinor: '999' },
      });
      const capture = await lifecycle.captureCheckoutOrder({
        ...scope,
        idempotencyKey: 'cap-wrong-kind',
        checkoutOperationId: checkout.operationId,
        providerOrderId: checkout.providerOrderId ?? 'order-1',
      });

      await expect(
        lifecycle.getCheckoutOrder({
          ...scope,
          checkoutOperationId: capture.operationId,
        }),
      ).rejects.toMatchObject({
        code: PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
      });
    });

    it('rejects conflicting provider order id and checkout operation id', async () => {
      const store = new MemoryPaymentReliabilityStore();
      const lifecycle = new CheckoutLifecycleService(store, fakeProvider());
      const checkout = await lifecycle.createCheckoutOrder({
        ...scope,
        idempotencyKey: 'idem-conflict',
        amount: { currency: 'USD', amountMinor: '999' },
      });

      await expect(
        lifecycle.getCheckoutOrder({
          ...scope,
          checkoutOperationId: checkout.operationId,
          providerOrderId: 'other-order-id',
        }),
      ).rejects.toMatchObject({
        code: PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
      });
    });

    it('preserves providerOrderId-only lookup behavior', async () => {
      const store = new MemoryPaymentReliabilityStore();
      const provider = fakeProvider();
      const lifecycle = new CheckoutLifecycleService(store, provider);
      await lifecycle.createCheckoutOrder({
        ...scope,
        idempotencyKey: 'idem-provider-only',
        amount: { currency: 'USD', amountMinor: '999' },
      });

      vi.mocked(provider.getOrder).mockClear();
      vi.mocked(provider.createOrder).mockClear();
      vi.mocked(provider.captureOrder).mockClear();

      const result = await lifecycle.getCheckoutOrder({
        ...scope,
        providerOrderId: 'order-1',
      });

      expect(result.providerOrderId).toBe('order-1');
      expect(provider.getOrder).toHaveBeenCalledTimes(1);
      expect(provider.createOrder).not.toHaveBeenCalled();
      expect(provider.captureOrder).not.toHaveBeenCalled();
    });
  });

  describe('unresolved checkout nextAction presentation', () => {
    const scope = {
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox' as const,
    };
    const createInput = {
      ...scope,
      idempotencyKey: 'idem-next-action',
      amount: { currency: 'USD', amountMinor: '999' },
      referenceId: 'fund-next-action',
      returnUrl: 'https://example.com/return',
      cancelUrl: 'https://example.com/cancel',
    };
    const alwaysAllowRetry: CheckoutCreateRetryOptions = {
      evaluateProviderCreateRetryEligibility: () => 'allowed',
    };
    const alwaysExpiredRetry: CheckoutCreateRetryOptions = {
      evaluateProviderCreateRetryEligibility: () => 'expired',
    };
    const alwaysUnavailableRetry: CheckoutCreateRetryOptions = {
      evaluateProviderCreateRetryEligibility: () => 'unavailable',
    };

    async function seedSubmittedCheckoutWithoutProvider(
      store: MemoryPaymentReliabilityStore,
      idempotencyKey: string,
    ) {
      const amount = createInput.amount;
      const fingerprint = buildCommandFingerprint({
        amount,
        referenceId: createInput.referenceId ?? null,
        returnUrl: createInput.returnUrl ?? null,
        cancelUrl: createInput.cancelUrl ?? null,
      });
      const idempotencyScope = buildOperationIdempotencyScope({
        applicationRef: scope.applicationRef,
        accountRef: scope.accountRef,
        environment: scope.environment,
        kind: 'checkout',
      });
      const created = await store.createOperation({
        idempotencyKey,
        idempotencyScope,
        commandFingerprint: fingerprint,
        providerCode: scope.providerCode,
        accountRef: scope.accountRef,
        applicationRef: scope.applicationRef,
        environment: scope.environment,
        kind: 'checkout',
        amountMinor: amount.amountMinor,
        currencyCode: amount.currency,
      });
      const claimed = await store.acquireCheckoutCreateExecutionLease({
        operationId: created.operationId,
        expectedVersion: created.version,
      });
      if (claimed.kind !== 'acquired') {
        throw new Error(`expected acquired lease, got ${claimed.kind}`);
      }
      return claimed.operation.operationId;
    }

    function advancePastExecutionLease() {
      vi.advanceTimersByTime(CHECKOUT_CREATE_EXECUTION_LEASE_MS + 1);
    }

    it('returns check_status while execution lease is active on GET', async () => {
      vi.useFakeTimers();
      try {
        const store = new MemoryPaymentReliabilityStore();
        const provider = fakeProvider();
        const lifecycle = new CheckoutLifecycleService(store, provider);
        const operationId = await seedSubmittedCheckoutWithoutProvider(
          store,
          'idem-active-lease-get',
        );

        vi.mocked(provider.createOrder).mockClear();
        vi.mocked(provider.getOrder).mockClear();

        const result = await lifecycle.getCheckoutOrder(
          { ...scope, checkoutOperationId: operationId },
          alwaysAllowRetry,
        );

        expect(result.outcome).toBe('pending');
        expect(result.nextAction).toBe('check_status');
        expect(provider.getOrder).not.toHaveBeenCalled();
        expect(provider.createOrder).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('returns resume_operation after lease expiry when retry is eligible on GET', async () => {
      vi.useFakeTimers();
      try {
        const store = new MemoryPaymentReliabilityStore();
        const provider = fakeProvider();
        const lifecycle = new CheckoutLifecycleService(store, provider);
        const operationId = await seedSubmittedCheckoutWithoutProvider(
          store,
          'idem-expired-lease-get',
        );
        advancePastExecutionLease();

        const result = await lifecycle.getCheckoutOrder(
          { ...scope, checkoutOperationId: operationId },
          alwaysAllowRetry,
        );

        expect(result.outcome).toBe('unknown');
        expect(result.nextAction).toBe('resume_operation');
        expect(provider.createOrder).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('returns contact_support when PayPal retry window is expired on GET', async () => {
      vi.useFakeTimers();
      try {
        const store = new MemoryPaymentReliabilityStore();
        const provider = fakeProvider();
        const lifecycle = new CheckoutLifecycleService(store, provider);
        const operationId = await seedSubmittedCheckoutWithoutProvider(
          store,
          'idem-paypal-expired-get',
        );
        advancePastExecutionLease();

        const result = await lifecycle.getCheckoutOrder(
          { ...scope, checkoutOperationId: operationId },
          alwaysExpiredRetry,
        );

        expect(result.outcome).toBe('unknown');
        expect(result.nextAction).toBe('contact_support');
        expect(provider.createOrder).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('returns contact_support for unknown without provider when eligibility evidence is unavailable', async () => {
      const store = new MemoryPaymentReliabilityStore();
      const provider = fakeProvider();
      provider.createOrder.mockRejectedValueOnce({
        code: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
        message: 'PayPal HTTP request timed out',
        retryable: true,
        uncertain: true,
      });
      const lifecycle = new CheckoutLifecycleService(store, provider);
      const created = await lifecycle.createCheckoutOrder(createInput, alwaysUnavailableRetry);
      expect(created.nextAction).toBe('contact_support');

      const loaded = await lifecycle.getCheckoutOrder(
        { ...scope, checkoutOperationId: created.operationId },
        alwaysUnavailableRetry,
      );
      expect(loaded.outcome).toBe('unknown');
      expect(loaded.nextAction).toBe('contact_support');
      expect(provider.createOrder).toHaveBeenCalledTimes(1);
    });
  });

  describe('retryCheckoutOrder', () => {
    const scope = {
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'test-app',
      environment: 'sandbox' as const,
    };
    const createInput = {
      ...scope,
      idempotencyKey: 'idem-retry-base',
      amount: { currency: 'USD', amountMinor: '999' },
      referenceId: 'fund-retry-1',
      returnUrl: 'https://example.com/return',
      cancelUrl: 'https://example.com/cancel',
    };
    const alwaysAllowRetry: CheckoutCreateRetryOptions = {
      evaluateProviderCreateRetryEligibility: () => 'allowed',
    };

    async function seedSubmittedCheckoutWithoutProvider(
      store: MemoryPaymentReliabilityStore,
      idempotencyKey: string,
    ) {
      const amount = createInput.amount;
      const fingerprint = buildCommandFingerprint({
        amount,
        referenceId: createInput.referenceId ?? null,
        returnUrl: createInput.returnUrl ?? null,
        cancelUrl: createInput.cancelUrl ?? null,
      });
      const idempotencyScope = buildOperationIdempotencyScope({
        applicationRef: scope.applicationRef,
        accountRef: scope.accountRef,
        environment: scope.environment,
        kind: 'checkout',
      });
      const created = await store.createOperation({
        idempotencyKey,
        idempotencyScope,
        commandFingerprint: fingerprint,
        providerCode: scope.providerCode,
        accountRef: scope.accountRef,
        applicationRef: scope.applicationRef,
        environment: scope.environment,
        kind: 'checkout',
        amountMinor: amount.amountMinor,
        currencyCode: amount.currency,
      });
      const claimed = await store.acquireCheckoutCreateExecutionLease({
        operationId: created.operationId,
        expectedVersion: created.version,
      });
      if (claimed.kind !== 'acquired') {
        throw new Error(`expected acquired lease, got ${claimed.kind}`);
      }
      return claimed.operation.operationId;
    }

    function advancePastExecutionLease() {
      vi.advanceTimersByTime(CHECKOUT_CREATE_EXECUTION_LEASE_MS + 1);
    }

    async function seedUnknownCheckoutWithoutOrder(
      store: MemoryPaymentReliabilityStore,
      provider: ReturnType<typeof fakeProvider>,
    ) {
      provider.createOrder.mockRejectedValueOnce({
        code: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
        message: 'PayPal HTTP request timed out',
        retryable: true,
        uncertain: true,
      });
      const lifecycle = new CheckoutLifecycleService(store, provider);
      const created = await lifecycle.createCheckoutOrder(createInput);
      expect(created.outcome).toBe('unknown');
      expect(created.providerOrderId).toBeNull();
      vi.mocked(provider.createOrder).mockClear();
      return { lifecycle, operationId: created.operationId };
    }

    function retryPayload(operationId: string) {
      return {
        ...scope,
        checkoutOperationId: operationId,
        amount: createInput.amount,
        referenceId: createInput.referenceId,
        returnUrl: createInput.returnUrl,
        cancelUrl: createInput.cancelUrl,
      };
    }

    it('reuses the same operation id and parameters on explicit retry', async () => {
      const store = new MemoryPaymentReliabilityStore();
      const provider = fakeProvider();
      const { lifecycle, operationId } = await seedUnknownCheckoutWithoutOrder(store, provider);

      const retried = await lifecycle.retryCheckoutOrder(
        retryPayload(operationId),
        alwaysAllowRetry,
      );

      expect(retried.providerOrderId).toBe('order-1');
      expect(provider.createOrder).toHaveBeenCalledTimes(1);
      expect(provider.createOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          providerRequestId: operationId,
          amount: createInput.amount,
          referenceId: createInput.referenceId,
        }),
      );
    });

    it('rejects changed retry parameters before calling the provider', async () => {
      const store = new MemoryPaymentReliabilityStore();
      const provider = fakeProvider();
      const { lifecycle, operationId } = await seedUnknownCheckoutWithoutOrder(store, provider);

      await expect(
        lifecycle.retryCheckoutOrder(
          {
            ...retryPayload(operationId),
            amount: { currency: 'USD', amountMinor: '1000' },
          },
          alwaysAllowRetry,
        ),
      ).rejects.toMatchObject({ code: PAYMENT_RELIABILITY_ERROR.IDEMPOTENCY_CONFLICT });
      expect(provider.createOrder).not.toHaveBeenCalled();
    });

    it('returns contact_support without provider call when retry window is unavailable', async () => {
      const store = new MemoryPaymentReliabilityStore();
      const provider = fakeProvider();
      const { lifecycle, operationId } = await seedUnknownCheckoutWithoutOrder(store, provider);

      const blocked = await lifecycle.retryCheckoutOrder(retryPayload(operationId), {
        evaluateProviderCreateRetryEligibility: () => 'unavailable',
      });

      expect(blocked.outcome).toBe('unknown');
      expect(blocked.nextAction).toBe('contact_support');
      expect(provider.createOrder).not.toHaveBeenCalled();
    });

    it('returns contact_support without provider call when retry window is expired', async () => {
      const store = new MemoryPaymentReliabilityStore();
      const provider = fakeProvider();
      const { lifecycle, operationId } = await seedUnknownCheckoutWithoutOrder(store, provider);

      const blocked = await lifecycle.retryCheckoutOrder(retryPayload(operationId), {
        evaluateProviderCreateRetryEligibility: () => 'expired',
      });

      expect(blocked.nextAction).toBe('contact_support');
      expect(provider.createOrder).not.toHaveBeenCalled();
    });

    it('allows only one concurrent retry provider call', async () => {
      const store = new MemoryPaymentReliabilityStore();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const provider = fakeProvider();
      provider.createOrder
        .mockRejectedValueOnce({
          code: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
          message: 'PayPal HTTP request timed out',
          retryable: true,
          uncertain: true,
        })
        .mockImplementation(async () => {
          await gate;
          return {
            providerOrderId: 'order-concurrent',
            checkoutStatus: 'created' as const,
            approvalUrl: 'https://sandbox.paypal.com/approve/order-concurrent',
            amount: { currency: 'USD', amountMinor: '999' },
          };
        });
      const lifecycle = new CheckoutLifecycleService(store, provider);
      const created = await lifecycle.createCheckoutOrder(createInput);
      vi.mocked(provider.createOrder).mockClear();
      const payload = retryPayload(created.operationId);

      const first = lifecycle.retryCheckoutOrder(payload, alwaysAllowRetry);
      const second = lifecycle.retryCheckoutOrder(payload, alwaysAllowRetry);
      release();
      const results = await Promise.allSettled([first, second]);

      expect(provider.createOrder).toHaveBeenCalledTimes(1);
      const fulfilled = results.filter(
        (result): result is PromiseFulfilledResult<Awaited<typeof first>> =>
          result.status === 'fulfilled',
      );
      expect(fulfilled.some((result) => result.value.providerOrderId === 'order-concurrent')).toBe(
        true,
      );
    });

    it('returns pending for a fresh submitted claim without calling the provider', async () => {
      const store = new MemoryPaymentReliabilityStore();
      const provider = fakeProvider();
      const lifecycle = new CheckoutLifecycleService(store, provider);
      const operationId = await seedSubmittedCheckoutWithoutProvider(store, 'idem-fresh-submitted');

      const result = await lifecycle.retryCheckoutOrder(
        retryPayload(operationId),
        alwaysAllowRetry,
      );

      expect(result.outcome).toBe('pending');
      expect(provider.createOrder).not.toHaveBeenCalled();
    });

    it('retries provider create after the execution lease expires on submitted checkout', async () => {
      vi.useFakeTimers();
      try {
        const store = new MemoryPaymentReliabilityStore();
        const provider = fakeProvider();
        const lifecycle = new CheckoutLifecycleService(store, provider);
        const operationId = await seedSubmittedCheckoutWithoutProvider(
          store,
          'idem-expired-submitted',
        );
        advancePastExecutionLease();

        const result = await lifecycle.retryCheckoutOrder(
          retryPayload(operationId),
          alwaysAllowRetry,
        );

        expect(result.providerOrderId).toBe('order-1');
        expect(provider.createOrder).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('treats a fresh retry execution claim as still in flight', async () => {
      const store = new MemoryPaymentReliabilityStore();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const provider = fakeProvider();
      const { lifecycle, operationId } = await seedUnknownCheckoutWithoutOrder(store, provider);
      provider.createOrder.mockImplementation(async () => {
        await gate;
        return {
          providerOrderId: 'order-retry-gate',
          checkoutStatus: 'created' as const,
          approvalUrl: 'https://sandbox.paypal.com/approve/order-retry-gate',
          amount: createInput.amount,
        };
      });

      const inFlightRetry = lifecycle.retryCheckoutOrder(
        retryPayload(operationId),
        alwaysAllowRetry,
      );
      const blockedRetry = lifecycle.retryCheckoutOrder(
        retryPayload(operationId),
        alwaysAllowRetry,
      );
      release();
      const [first, second] = await Promise.all([inFlightRetry, blockedRetry]);

      expect(provider.createOrder).toHaveBeenCalledTimes(1);
      expect(second.outcome).toBe('pending');
      expect(first.providerOrderId).toBe('order-retry-gate');
    });

    it('allows only one concurrent retry provider call after lease expiry', async () => {
      vi.useFakeTimers();
      try {
        const store = new MemoryPaymentReliabilityStore();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const provider = fakeProvider();
        const lifecycle = new CheckoutLifecycleService(store, provider);
        const operationId = await seedSubmittedCheckoutWithoutProvider(
          store,
          'idem-concurrent-reclaim',
        );
        advancePastExecutionLease();
        provider.createOrder.mockImplementation(async () => {
          await gate;
          return {
            providerOrderId: 'order-reclaim-concurrent',
            checkoutStatus: 'created' as const,
            approvalUrl: 'https://sandbox.paypal.com/approve/order-reclaim-concurrent',
            amount: createInput.amount,
          };
        });

        const first = lifecycle.retryCheckoutOrder(retryPayload(operationId), alwaysAllowRetry);
        const second = lifecycle.retryCheckoutOrder(retryPayload(operationId), alwaysAllowRetry);
        release();
        await Promise.all([first, second]);

        expect(provider.createOrder).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('rejects result writes from a stale execution owner token', async () => {
      const store = new MemoryPaymentReliabilityStore();
      const provider = fakeProvider();
      const lifecycle = new CheckoutLifecycleService(store, provider);
      const { operationId } = await seedUnknownCheckoutWithoutOrder(store, provider);
      const leased = await store.acquireCheckoutCreateExecutionLease({
        operationId,
        expectedVersion: (await store.findOperationById(operationId))?.version ?? 1,
      });
      if (leased.kind !== 'acquired') {
        throw new Error('expected acquired lease');
      }
      const staleToken = '00000000-0000-4000-8000-000000000000';

      await expect(
        store.transitionOperation({
          operationId,
          expectedVersion: leased.operation.version,
          expectedExecutionOwnerToken: staleToken,
          nextStatus: 'submitted',
          providerOrderId: 'order-stale',
          providerReferenceId: 'order-stale',
          reason: 'Stale owner attempt',
        }),
      ).rejects.toMatchObject({
        code: PAYMENT_RELIABILITY_ERROR.TRANSITION_REJECTED,
        rejectionReason: PAYMENT_TRANSITION_REJECTION_REASON.EXECUTION_OWNER_MISMATCH,
      });

      const refreshed = await store.findOperationById(operationId);
      expect(refreshed?.providerOrderId).toBeNull();
      expect(provider.createOrder).not.toHaveBeenCalled();
      void lifecycle;
    });

    it('keeps the original provider execution anchor for PayPal idempotency', async () => {
      vi.useFakeTimers();
      try {
        const store = new MemoryPaymentReliabilityStore();
        const provider = fakeProvider();
        const lifecycle = new CheckoutLifecycleService(store, provider);
        const operationId = await seedSubmittedCheckoutWithoutProvider(
          store,
          'idem-anchor-unchanged',
        );
        const transitionsBefore = await store.listOperationTransitions(operationId);
        const initialClaim = transitionsBefore.find(
          (row) => row.reason === 'Claimed for provider execution',
        );
        const evaluateEligibility = vi.fn().mockReturnValue('allowed' as const);
        advancePastExecutionLease();

        await lifecycle.retryCheckoutOrder(retryPayload(operationId), {
          ...alwaysAllowRetry,
          evaluateProviderCreateRetryEligibility: evaluateEligibility,
        });

        expect(evaluateEligibility).toHaveBeenCalledWith(initialClaim?.createdAt ?? null);
        const transitionsAfter = await store.listOperationTransitions(operationId);
        expect(
          transitionsAfter.filter((row) => row.reason === 'Claimed for provider execution'),
        ).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('surfaces resume_operation for unknown checkout without provider binding', async () => {
      const store = new MemoryPaymentReliabilityStore();
      const provider = fakeProvider();
      provider.createOrder.mockRejectedValueOnce({
        code: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
        message: 'PayPal HTTP request timed out',
        retryable: true,
        uncertain: true,
      });
      const lifecycle = new CheckoutLifecycleService(store, provider);
      const created = await lifecycle.createCheckoutOrder(createInput);
      expect(created.outcome).toBe('unknown');
      expect(created.nextAction).toBe('resume_operation');
    });

    it('keeps unknown when retry times out again', async () => {
      const store = new MemoryPaymentReliabilityStore();
      const provider = fakeProvider();
      const { lifecycle, operationId } = await seedUnknownCheckoutWithoutOrder(store, provider);
      provider.createOrder.mockRejectedValueOnce({
        code: PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
        message: 'PayPal HTTP request timed out',
        retryable: true,
        uncertain: true,
      });

      const retried = await lifecycle.retryCheckoutOrder(
        retryPayload(operationId),
        alwaysAllowRetry,
      );

      expect(retried.outcome).toBe('unknown');
      expect(retried.providerOrderId).toBeNull();
    });

    it('does not retry on ordinary create replay or get lookup', async () => {
      const store = new MemoryPaymentReliabilityStore();
      const provider = fakeProvider();
      const { lifecycle, operationId } = await seedUnknownCheckoutWithoutOrder(store, provider);

      await lifecycle.createCheckoutOrder(createInput);
      await lifecycle.getCheckoutOrder({ ...scope, checkoutOperationId: operationId });

      expect(provider.createOrder).toHaveBeenCalledTimes(0);
      expect(provider.getOrder).toHaveBeenCalledTimes(0);
    });
  });
});
