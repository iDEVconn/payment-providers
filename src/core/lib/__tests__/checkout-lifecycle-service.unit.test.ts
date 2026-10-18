import { describe, expect, it, vi } from 'vitest';
import { PAYMENT_RELIABILITY_ERROR, PaymentReliabilityError } from '../../../contracts/index';
import type { CheckoutProviderPort } from '../checkout-provider-port';
import { CheckoutLifecycleService } from '../checkout-lifecycle-service';
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
      applicationRef: 'edc',
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
      applicationRef: 'edc',
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
      applicationRef: 'edc',
      environment: 'sandbox',
      idempotencyKey: 'idem-3',
      amount: { currency: 'USD', amountMinor: '999' },
    });

    await expect(
      service.createCheckoutOrder({
        providerCode: 'paypal',
        accountRef: 'default',
        applicationRef: 'edc',
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
      applicationRef: 'edc',
      environment: 'sandbox',
      idempotencyKey: 'idem-4',
      amount: { currency: 'USD', amountMinor: '999' },
    });

    const captureInput = {
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'edc',
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
      applicationRef: 'edc',
      environment: 'sandbox',
      idempotencyKey: 'idem-refund-cap',
      amount: { currency: 'USD', amountMinor: '1000' },
    });
    const capture = await lifecycle.captureCheckoutOrder({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'edc',
      environment: 'sandbox',
      idempotencyKey: 'cap-refund-cap',
      checkoutOperationId: checkout.operationId,
      providerOrderId: checkout.providerOrderId ?? 'order-1',
    });

    await lifecycle.refundCapture({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'edc',
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
        applicationRef: 'edc',
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
      applicationRef: 'edc',
      environment: 'sandbox',
      idempotencyKey: 'idem-continuation',
      amount: { currency: 'USD', amountMinor: '999' },
    });

    const captureInput = {
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'edc',
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
      applicationRef: 'edc',
      environment: 'sandbox',
      idempotencyKey: 'idem-unknown-retry',
      amount: { currency: 'USD', amountMinor: '999' },
    });

    const captureInput = {
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'edc',
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
      applicationRef: 'edc',
      environment: 'sandbox',
      idempotencyKey: 'idem-overlap',
      amount: { currency: 'USD', amountMinor: '999' },
    });

    const captureInput = {
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'edc',
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
      applicationRef: 'edc',
      environment: 'sandbox',
      idempotencyKey: 'idem-reconcile-amount',
      amount: { currency: 'USD', amountMinor: '999' },
    });

    const captured = await lifecycle.captureCheckoutOrder({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'edc',
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
      applicationRef: 'edc',
      environment: 'sandbox',
      idempotencyKey: 'idem-missing-capture-amount',
      amount: { currency: 'USD', amountMinor: '999' },
    });

    const captured = await lifecycle.captureCheckoutOrder({
      providerCode: 'paypal',
      accountRef: 'default',
      applicationRef: 'edc',
      environment: 'sandbox',
      idempotencyKey: 'cap-missing-capture-amount',
      checkoutOperationId: checkout.operationId,
      providerOrderId: checkout.providerOrderId ?? 'order-1',
    });

    expect(captured.captureStatus).toBe('unknown');
    expect(captured.providerCaptureId).toBeNull();
  });

  it('returns provider order id when local persistence fails after provider create', async () => {
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
      applicationRef: 'edc',
      environment: 'sandbox',
      idempotencyKey: 'idem-persist-fail',
      amount: { currency: 'USD', amountMinor: '999' },
    });

    expect(result.providerOrderId).toBe('order-1');
  });
});
