import {
  PAYMENT_RELIABILITY_ERROR,
  PaymentReliabilityError,
  type BillingPlanResult,
  type CatalogProductResult,
  type CreateBillingPlanRequest,
  type CreateCatalogProductRequest,
  type CreateSubscriptionRequest,
  type GetBillingPlanRequest,
  type GetBillingPlanResult,
  type GetCatalogProductRequest,
  type GetCatalogProductResult,
  type GetSubscriptionRequest,
  type GetSubscriptionResult,
  type PaymentOperation,
  type PlanLifecycleRequest,
  type PlanLifecycleResult,
  type SubscriptionLifecycleCommandRequest,
  type SubscriptionLifecycleCommandResult,
  type SubscriptionResult,
} from '../../contracts/index';
import { buildCommandFingerprint } from './command-fingerprint';
import { maskSubscriberEmail, maskSubscriberRef } from './mask-subscriber';
import { buildOperationIdempotencyScope } from './operation-idempotency';
import { validateBillingCycles } from './subscription-billing-cycles';
import type { SubscriptionProviderPort } from './subscription-provider-port';
import {
  planStatusToOperationStatus,
  subscriptionStatusToOperationStatus,
} from './subscription-transition-policy';
import type { PaymentReliabilityStore } from './persistence/payment-reliability-store';
import {
  applyPlanDomainUpdate,
  applySubscriptionDomainUpdate,
} from './subscription-evidence-application';

function isTerminal(status: PaymentOperation['status']): boolean {
  return status === 'succeeded' || status === 'failed';
}

function toProductResult(operation: PaymentOperation): CatalogProductResult {
  return {
    productOperationId: operation.operationId,
    operationStatus: operation.status,
    productStatus: operation.productStatus ?? 'unknown',
    providerProductId: operation.providerProductId,
    name: operation.itemRef ?? '',
    type: 'SERVICE',
    correlationId: operation.correlationId,
  };
}

function toPlanResult(operation: PaymentOperation): BillingPlanResult {
  return {
    planOperationId: operation.operationId,
    operationStatus: operation.status,
    planStatus: operation.planStatus ?? 'unknown',
    offeringRef: operation.offeringRef,
    providerPlanId: operation.providerPlanId,
    providerProductId: operation.providerProductId,
    name: operation.itemRef ?? '',
    billingCycles: [],
    correlationId: operation.correlationId,
  };
}

function toSubscriptionResult(operation: PaymentOperation): SubscriptionResult {
  return {
    subscriptionOperationId: operation.operationId,
    operationStatus: operation.status,
    subscriptionStatus: operation.subscriptionStatus ?? 'unknown',
    providerSubscriptionId: operation.providerSubscriptionId,
    providerPlanId: operation.providerPlanId,
    approvalUrl: operation.approvalUrl,
    maskedSubscriber: operation.maskedSubscriber ?? '***',
    startTime: operation.startTime,
    nextBillingTime: operation.nextBillingTime,
    lifecycleReason: operation.lifecycleReason,
    correlationId: operation.correlationId,
  };
}

type SubscriptionPlanReference =
  | { form: 'plan_operation'; planOperationId: string }
  | { form: 'provider_plan'; providerPlanId: string; offeringRef: string };

function resolveSubscriptionPlanReference(
  input: CreateSubscriptionRequest,
): SubscriptionPlanReference {
  const hasPlanOperation = input.planOperationId !== undefined;
  const hasProviderPlan = input.providerPlanId !== undefined || input.offeringRef !== undefined;
  if (hasPlanOperation && hasProviderPlan) {
    throw new PaymentReliabilityError(
      PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
      'Subscription plan reference is ambiguous',
    );
  }
  if (hasPlanOperation) {
    return { form: 'plan_operation', planOperationId: input.planOperationId as string };
  }
  const providerPlanId =
    typeof input.providerPlanId === 'string' ? input.providerPlanId.trim() : '';
  const offeringRef = typeof input.offeringRef === 'string' ? input.offeringRef.trim() : '';
  if (!providerPlanId || !offeringRef) {
    throw new PaymentReliabilityError(
      PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
      'Subscription plan reference is missing',
    );
  }
  return { form: 'provider_plan', providerPlanId, offeringRef };
}

export class SubscriptionLifecycleService {
  constructor(
    private readonly store: PaymentReliabilityStore,
    private readonly provider: SubscriptionProviderPort,
  ) {}

  async createCatalogProduct(input: CreateCatalogProductRequest): Promise<CatalogProductResult> {
    const fingerprint = buildCommandFingerprint({
      name: input.name,
      description: input.description ?? null,
      type: input.type,
      category: input.category ?? null,
    });
    const scope = buildOperationIdempotencyScope({
      applicationRef: input.applicationRef,
      accountRef: input.accountRef,
      environment: input.environment,
      kind: 'catalog_product',
    });

    let operation = await this.store.createOperation({
      idempotencyKey: input.idempotencyKey,
      idempotencyScope: scope,
      commandFingerprint: fingerprint,
      providerCode: input.providerCode,
      accountRef: input.accountRef,
      applicationRef: input.applicationRef,
      environment: input.environment,
      kind: 'catalog_product',
      correlationId: input.correlationId ?? null,
      itemRef: input.name,
      productStatus: 'created',
    });

    if (
      isTerminal(operation.status) ||
      operation.status === 'submitted' ||
      operation.status === 'unknown'
    ) {
      return toProductResult(operation);
    }

    operation = await this.store.claimOperationForExecution({
      operationId: operation.operationId,
      expectedVersion: operation.version,
    });

    try {
      const result = await this.provider.createProduct({
        providerCode: input.providerCode,
        accountRef: input.accountRef,
        applicationRef: input.applicationRef,
        environment: input.environment,
        providerRequestId: operation.operationId,
        name: input.name,
        description: input.description ?? null,
        type: input.type,
        category: input.category ?? null,
        homeUrl: input.homeUrl ?? null,
        imageUrl: input.imageUrl ?? null,
      });
      operation = await this.store.transitionOperation({
        operationId: operation.operationId,
        expectedVersion: operation.version,
        nextStatus: 'succeeded',
        productStatus: result.productStatus,
        providerProductId: result.providerProductId,
        providerReferenceId: result.providerProductId,
        reason: 'PayPal catalog product created',
      });
    } catch (error) {
      operation = await this.handleFailure(operation, error);
    }

    return toProductResult(operation);
  }

  async getCatalogProduct(input: GetCatalogProductRequest): Promise<GetCatalogProductResult> {
    const operation = await this.store.findOperationById(input.productOperationId);
    if (!operation || operation.kind !== 'catalog_product') {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Catalog product operation was not found',
      );
    }
    return toProductResult(operation);
  }

  async createBillingPlan(input: CreateBillingPlanRequest): Promise<BillingPlanResult> {
    const product = await this.store.findOperationById(input.productOperationId);
    if (!product || product.kind !== 'catalog_product' || !product.providerProductId) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Parent catalog product with provider reference was not found',
      );
    }

    const cycles = validateBillingCycles(input.billingCycles);
    const fingerprint = buildCommandFingerprint({
      productOperationId: input.productOperationId,
      offeringRef: input.offeringRef ?? null,
      name: input.name,
      cycles,
      paymentPreferences: input.paymentPreferences,
    });
    const scope = buildOperationIdempotencyScope({
      applicationRef: input.applicationRef,
      accountRef: input.accountRef,
      environment: input.environment,
      kind: 'billing_plan',
    });

    let operation = await this.store.createOperation({
      idempotencyKey: input.idempotencyKey,
      idempotencyScope: scope,
      commandFingerprint: fingerprint,
      providerCode: input.providerCode,
      accountRef: input.accountRef,
      applicationRef: input.applicationRef,
      environment: input.environment,
      kind: 'billing_plan',
      correlationId: input.correlationId ?? null,
      parentOperationId: product.operationId,
      providerProductId: product.providerProductId,
      offeringRef: input.offeringRef ?? null,
      itemRef: input.name,
      planStatus: input.status === 'ACTIVE' ? 'active' : 'created',
    });

    if (
      isTerminal(operation.status) ||
      operation.status === 'submitted' ||
      operation.status === 'unknown'
    ) {
      return toPlanResult(operation);
    }

    operation = await this.store.claimOperationForExecution({
      operationId: operation.operationId,
      expectedVersion: operation.version,
    });

    try {
      const result = await this.provider.createPlan({
        providerCode: input.providerCode,
        accountRef: input.accountRef,
        applicationRef: input.applicationRef,
        environment: input.environment,
        providerRequestId: operation.operationId,
        providerProductId: product.providerProductId,
        name: input.name,
        description: input.description ?? null,
        status: input.status ?? 'CREATED',
        billingCycles: cycles,
        paymentPreferences: input.paymentPreferences,
        returnUrl: input.returnUrl ?? null,
        cancelUrl: input.cancelUrl ?? null,
      });
      operation = await this.store.transitionOperation({
        operationId: operation.operationId,
        expectedVersion: operation.version,
        nextStatus: planStatusToOperationStatus(result.planStatus),
        planStatus: result.planStatus,
        providerPlanId: result.providerPlanId,
        providerReferenceId: result.providerPlanId,
        reason: 'PayPal billing plan created',
      });
    } catch (error) {
      operation = await this.handleFailure(operation, error);
    }

    return toPlanResult(operation);
  }

  async getBillingPlan(input: GetBillingPlanRequest): Promise<GetBillingPlanResult> {
    const operation = await this.store.findOperationById(input.planOperationId);
    if (!operation || operation.kind !== 'billing_plan') {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Billing plan operation was not found',
      );
    }
    return toPlanResult(operation);
  }

  async activateBillingPlan(input: PlanLifecycleRequest): Promise<PlanLifecycleResult> {
    return this.runPlanLifecycle(input, 'activate');
  }

  async deactivateBillingPlan(input: PlanLifecycleRequest): Promise<PlanLifecycleResult> {
    return this.runPlanLifecycle(input, 'deactivate');
  }

  async createSubscription(input: CreateSubscriptionRequest): Promise<SubscriptionResult> {
    const reference = resolveSubscriptionPlanReference(input);
    if (reference.form === 'provider_plan') {
      return this.createSubscriptionForProviderPlan(input, reference);
    }

    const plan = await this.store.findOperationById(reference.planOperationId);
    if (!plan || plan.kind !== 'billing_plan' || !plan.providerPlanId) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Parent billing plan with provider reference was not found',
      );
    }

    const fingerprint = buildCommandFingerprint({
      planOperationId: reference.planOperationId,
      subscriberRef: input.subscriber.subscriberRef,
      returnUrl: input.returnUrl ?? null,
      cancelUrl: input.cancelUrl ?? null,
    });

    const operation = await this.store.createOperation({
      ...this.subscriptionOperationBase(input, fingerprint),
      parentOperationId: plan.operationId,
      providerPlanId: plan.providerPlanId,
      offeringRef: plan.offeringRef ?? null,
    });

    return this.executeSubscriptionOperation(input, operation, plan.providerPlanId);
  }

  private async createSubscriptionForProviderPlan(
    input: CreateSubscriptionRequest,
    reference: { providerPlanId: string; offeringRef: string },
  ): Promise<SubscriptionResult> {
    const fingerprint = buildCommandFingerprint({
      providerPlanId: reference.providerPlanId,
      offeringRef: reference.offeringRef,
      subscriberRef: input.subscriber.subscriberRef,
      returnUrl: input.returnUrl ?? null,
      cancelUrl: input.cancelUrl ?? null,
    });
    const base = this.subscriptionOperationBase(input, fingerprint);

    const existing = await this.store.findOperationByIdempotency(
      base.idempotencyScope,
      base.idempotencyKey,
    );
    if (existing && existing.commandFingerprint !== fingerprint) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.IDEMPOTENCY_CONFLICT,
        'Idempotency key is already bound to a different command fingerprint',
      );
    }
    // Only a new or still-prepared operation is about to reach the provider;
    // replays of submitted/unknown/terminal operations return stored state.
    if (!existing || existing.status === 'prepared') {
      await this.assertProviderPlanActive(input, reference.providerPlanId);
    }

    const operation = await this.store.createOperation({
      ...base,
      parentOperationId: null,
      providerPlanId: reference.providerPlanId,
      offeringRef: reference.offeringRef,
    });

    return this.executeSubscriptionOperation(input, operation, reference.providerPlanId);
  }

  private async assertProviderPlanActive(
    input: CreateSubscriptionRequest,
    providerPlanId: string,
  ): Promise<void> {
    const plan = await this.provider.getPlan({
      providerCode: input.providerCode,
      accountRef: input.accountRef,
      applicationRef: input.applicationRef,
      environment: input.environment,
      providerPlanId,
    });
    if (plan.providerPlanId !== providerPlanId || plan.planStatus !== 'active') {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Provider billing plan is not active in the configured environment',
      );
    }
  }

  private subscriptionOperationBase(input: CreateSubscriptionRequest, fingerprint: string) {
    return {
      idempotencyKey: input.idempotencyKey,
      idempotencyScope: buildOperationIdempotencyScope({
        applicationRef: input.applicationRef,
        accountRef: input.accountRef,
        environment: input.environment,
        kind: 'subscription',
      }),
      commandFingerprint: fingerprint,
      providerCode: input.providerCode,
      accountRef: input.accountRef,
      applicationRef: input.applicationRef,
      environment: input.environment,
      kind: 'subscription' as const,
      correlationId: input.correlationId ?? null,
      subscriberRef: input.subscriber.subscriberRef,
      subscriberEmail: input.subscriber.email ?? null,
      maskedSubscriber:
        input.subscriber.email != null
          ? maskSubscriberEmail(input.subscriber.email)
          : maskSubscriberRef(input.subscriber.subscriberRef),
      subscriptionStatus: 'approval_pending' as const,
    };
  }

  private async executeSubscriptionOperation(
    input: CreateSubscriptionRequest,
    created: PaymentOperation,
    providerPlanId: string,
  ): Promise<SubscriptionResult> {
    let operation = created;
    if (
      isTerminal(operation.status) ||
      operation.status === 'submitted' ||
      operation.status === 'unknown'
    ) {
      return toSubscriptionResult(operation);
    }

    operation = await this.store.claimOperationForExecution({
      operationId: operation.operationId,
      expectedVersion: operation.version,
    });

    try {
      const result = await this.provider.createSubscription({
        providerCode: input.providerCode,
        accountRef: input.accountRef,
        applicationRef: input.applicationRef,
        environment: input.environment,
        providerRequestId: operation.operationId,
        providerPlanId,
        subscriberEmail: input.subscriber.email ?? null,
        returnUrl: input.returnUrl ?? null,
        cancelUrl: input.cancelUrl ?? null,
      });
      operation = await this.store.transitionOperation({
        operationId: operation.operationId,
        expectedVersion: operation.version,
        nextStatus: subscriptionStatusToOperationStatus(result.subscriptionStatus),
        subscriptionStatus: result.subscriptionStatus,
        providerSubscriptionId: result.providerSubscriptionId,
        providerReferenceId: result.providerSubscriptionId,
        approvalUrl: result.approvalUrl,
        startTime: result.startTime,
        nextBillingTime: result.nextBillingTime,
        reason: 'PayPal subscription created awaiting approval if required',
      });
    } catch (error) {
      operation = await this.handleFailure(operation, error);
    }

    return toSubscriptionResult(operation);
  }

  async getSubscription(input: GetSubscriptionRequest): Promise<GetSubscriptionResult> {
    const operation = await this.store.findOperationById(input.subscriptionOperationId);
    if (!operation || operation.kind !== 'subscription') {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Subscription operation was not found',
      );
    }
    return toSubscriptionResult(operation);
  }

  async cancelSubscription(
    input: SubscriptionLifecycleCommandRequest,
  ): Promise<SubscriptionLifecycleCommandResult> {
    return this.runSubscriptionLifecycle(input, 'subscription_cancel', (providerSubscriptionId) =>
      this.provider.cancelSubscription({
        providerCode: input.providerCode,
        accountRef: input.accountRef,
        applicationRef: input.applicationRef,
        environment: input.environment,
        providerSubscriptionId,
        reason: input.reason,
      }),
    );
  }

  async suspendSubscription(
    input: SubscriptionLifecycleCommandRequest,
  ): Promise<SubscriptionLifecycleCommandResult> {
    return this.runSubscriptionLifecycle(input, 'subscription_suspend', (providerSubscriptionId) =>
      this.provider.suspendSubscription({
        providerCode: input.providerCode,
        accountRef: input.accountRef,
        applicationRef: input.applicationRef,
        environment: input.environment,
        providerSubscriptionId,
        reason: input.reason,
      }),
    );
  }

  async activateSubscription(
    input: SubscriptionLifecycleCommandRequest,
  ): Promise<SubscriptionLifecycleCommandResult> {
    return this.runSubscriptionLifecycle(input, 'subscription_activate', (providerSubscriptionId) =>
      this.provider.activateSubscription({
        providerCode: input.providerCode,
        accountRef: input.accountRef,
        applicationRef: input.applicationRef,
        environment: input.environment,
        providerSubscriptionId,
        reason: input.reason,
      }),
    );
  }

  private async runPlanLifecycle(
    input: PlanLifecycleRequest,
    action: 'activate' | 'deactivate',
  ): Promise<PlanLifecycleResult> {
    const plan = await this.store.findOperationById(input.planOperationId);
    if (!plan || plan.kind !== 'billing_plan' || !plan.providerPlanId) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Billing plan with provider reference was not found',
      );
    }

    const fingerprint = buildCommandFingerprint({ planOperationId: input.planOperationId, action });
    const scope = buildOperationIdempotencyScope({
      applicationRef: input.applicationRef,
      accountRef: input.accountRef,
      environment: input.environment,
      kind: 'plan_lifecycle',
    });

    let operation = await this.store.createOperation({
      idempotencyKey: input.idempotencyKey,
      idempotencyScope: scope,
      commandFingerprint: fingerprint,
      providerCode: input.providerCode,
      accountRef: input.accountRef,
      applicationRef: input.applicationRef,
      environment: input.environment,
      kind: 'plan_lifecycle',
      correlationId: input.correlationId ?? null,
      parentOperationId: plan.operationId,
      providerPlanId: plan.providerPlanId,
    });

    if (
      isTerminal(operation.status) ||
      operation.status === 'submitted' ||
      operation.status === 'unknown'
    ) {
      return toPlanResult(plan);
    }

    operation = await this.store.claimOperationForExecution({
      operationId: operation.operationId,
      expectedVersion: operation.version,
    });

    try {
      const lookup =
        action === 'activate'
          ? await this.provider.activatePlan({
              providerCode: input.providerCode,
              accountRef: input.accountRef,
              applicationRef: input.applicationRef,
              environment: input.environment,
              providerPlanId: plan.providerPlanId,
            })
          : await this.provider.deactivatePlan({
              providerCode: input.providerCode,
              accountRef: input.accountRef,
              applicationRef: input.applicationRef,
              environment: input.environment,
              providerPlanId: plan.providerPlanId,
            });

      operation = await this.store.transitionOperation({
        operationId: operation.operationId,
        expectedVersion: operation.version,
        nextStatus: 'succeeded',
        planStatus: lookup.planStatus,
        reason: `PayPal billing plan ${action}d`,
      });

      const currentPlan = await this.store.findOperationById(plan.operationId);
      if (!currentPlan) {
        throw new PaymentReliabilityError(
          PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
          'Billing plan with provider reference was not found',
        );
      }

      const updatedPlan = await applyPlanDomainUpdate(this.store, currentPlan, {
        planStatus: lookup.planStatus,
        reason: `PayPal billing plan ${action}d via lifecycle operation`,
      });
      return toPlanResult(updatedPlan);
    } catch (error) {
      await this.handleFailure(operation, error);
      return toPlanResult(plan);
    }
  }

  private async runSubscriptionLifecycle(
    input: SubscriptionLifecycleCommandRequest,
    kind: 'subscription_cancel' | 'subscription_suspend' | 'subscription_activate',
    execute: (providerSubscriptionId: string) => Promise<{
      subscriptionStatus: SubscriptionResult['subscriptionStatus'];
      lifecycleReason: string | null;
      startTime: string | null;
      nextBillingTime: string | null;
    }>,
  ): Promise<SubscriptionLifecycleCommandResult> {
    const subscription = await this.store.findOperationById(input.subscriptionOperationId);
    if (
      !subscription ||
      subscription.kind !== 'subscription' ||
      !subscription.providerSubscriptionId
    ) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Subscription with provider reference was not found',
      );
    }

    const fingerprint = buildCommandFingerprint({
      subscriptionOperationId: input.subscriptionOperationId,
      kind,
      reason: input.reason,
    });
    const scope = buildOperationIdempotencyScope({
      applicationRef: input.applicationRef,
      accountRef: input.accountRef,
      environment: input.environment,
      kind,
    });

    let commandOp = await this.store.createOperation({
      idempotencyKey: input.idempotencyKey,
      idempotencyScope: scope,
      commandFingerprint: fingerprint,
      providerCode: input.providerCode,
      accountRef: input.accountRef,
      applicationRef: input.applicationRef,
      environment: input.environment,
      kind,
      correlationId: input.correlationId ?? null,
      parentOperationId: subscription.operationId,
      providerSubscriptionId: subscription.providerSubscriptionId,
      lifecycleReason: input.reason,
    });

    if (
      isTerminal(commandOp.status) ||
      commandOp.status === 'submitted' ||
      commandOp.status === 'unknown'
    ) {
      return toSubscriptionResult(subscription);
    }

    commandOp = await this.store.claimOperationForExecution({
      operationId: commandOp.operationId,
      expectedVersion: commandOp.version,
    });

    try {
      const result = await execute(subscription.providerSubscriptionId);
      commandOp = await this.store.transitionOperation({
        operationId: commandOp.operationId,
        expectedVersion: commandOp.version,
        nextStatus: subscriptionStatusToOperationStatus(result.subscriptionStatus),
        subscriptionStatus: result.subscriptionStatus,
        reason: `PayPal subscription ${kind}`,
      });

      const currentSubscription = await this.store.findOperationById(subscription.operationId);
      if (!currentSubscription) {
        throw new PaymentReliabilityError(
          PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
          'Subscription with provider reference was not found',
        );
      }

      const updated = await applySubscriptionDomainUpdate(this.store, currentSubscription, {
        subscriptionStatus: result.subscriptionStatus,
        lifecycleReason: result.lifecycleReason ?? input.reason,
        startTime: result.startTime,
        nextBillingTime: result.nextBillingTime,
        reason: `PayPal subscription ${kind}`,
      });
      return toSubscriptionResult(updated);
    } catch (error) {
      await this.handleFailure(commandOp, error);
      return toSubscriptionResult(subscription);
    }
  }

  private async handleFailure(
    operation: PaymentOperation,
    error: unknown,
  ): Promise<PaymentOperation> {
    const err = error as {
      code?: string;
      message?: string;
      uncertain?: boolean;
      retryable?: boolean;
    };
    const nextStatus =
      err?.uncertain || err?.retryable
        ? 'unknown'
        : err?.code === PAYMENT_RELIABILITY_ERROR.PROVIDER_TERMINAL_REJECTION
          ? 'failed'
          : 'unknown';

    const current = await this.store.findOperationById(operation.operationId);
    if (!current) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.OPERATION_CONFLICT,
        'Operation was not found',
      );
    }

    return this.store.transitionOperation({
      operationId: current.operationId,
      expectedVersion: current.version,
      nextStatus,
      subscriptionStatus: nextStatus === 'unknown' ? 'unknown' : current.subscriptionStatus,
      planStatus: nextStatus === 'unknown' ? 'unknown' : current.planStatus,
      productStatus: nextStatus === 'unknown' ? 'unknown' : current.productStatus,
      failureCode: err?.code ?? PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN,
      failureMessage: err instanceof Error ? err.message : String(error),
      reason: 'Subscription provider mutation returned uncertain or terminal outcome',
    });
  }
}
