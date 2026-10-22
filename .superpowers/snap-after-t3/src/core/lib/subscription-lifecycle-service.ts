import {
  PAYMENT_RELIABILITY_ERROR,
  PAYMENT_TRANSITION_REJECTION_REASON,
  PaymentReliabilityError,
  type PaymentReliabilityErrorCode,
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
  type ExecuteSubscriptionLifecycleResult,
  type SubscriptionLifecycleCommandRequest,
  type SubscriptionLifecycleCommandResult,
  type SubscriptionResult,
  type RetrySubscriptionCreateRequest,
  type SubscriptionCreateOptions,
  type SubscriptionProviderContext,
  type SubscriptionProviderCreateRetryEligibility,
  isExecuteSubscriptionLifecycleRefreshPending,
} from '../../contracts/index';
import { buildCommandFingerprint } from './command-fingerprint';
import {
  formatProviderFailureMessage,
  isTerminalPreProviderFailureCode,
  resolveProviderFailure,
} from './resolve-provider-failure';
import { maskSubscriberEmail, maskSubscriberRef } from './mask-subscriber';
import { buildOperationIdempotencyScope } from './operation-idempotency';
import { validateBillingCycles } from './subscription-billing-cycles';
import {
  resolveSubscriptionCreateOptions,
  subscriptionCreateFingerprintFields,
} from './subscription-create-options';
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
import {
  assertSubscriptionProviderPlanSnapshotConsistent,
  isSubscriptionProviderPlanMismatchError,
} from './subscription-provider-plan-consistency';

const SUBSCRIPTION_CLAIMED_FOR_EXECUTION_REASON = 'Claimed for provider execution';

function isTerminal(status: PaymentOperation['status']): boolean {
  return status === 'succeeded' || status === 'failed';
}

export type SubscriptionCreateRetryOptions = {
  evaluateProviderCreateRetryEligibility: (
    firstProviderExecutionAt: string | null,
  ) => SubscriptionProviderCreateRetryEligibility;
};

function buildSubscriptionCreateCommandFingerprint(
  input: Pick<
    CreateSubscriptionRequest,
    | 'subscriber'
    | 'returnUrl'
    | 'cancelUrl'
    | 'planOperationId'
    | 'providerPlanId'
    | 'offeringRef'
    | keyof SubscriptionCreateOptions
  >,
): string {
  const reference = resolveSubscriptionPlanReference(input);
  const common = {
    subscriberRef: input.subscriber.subscriberRef,
    returnUrl: input.returnUrl ?? null,
    cancelUrl: input.cancelUrl ?? null,
    ...subscriptionCreateFingerprintFields(input),
  };
  if (reference.form === 'plan_operation') {
    return buildCommandFingerprint({ planOperationId: reference.planOperationId, ...common });
  }
  return buildCommandFingerprint({
    providerPlanId: reference.providerPlanId,
    offeringRef: reference.offeringRef,
    ...common,
  });
}

function assertSubscriptionOperationScope(
  operation: PaymentOperation,
  input: SubscriptionProviderContext & { subscriptionOperationId?: string },
): void {
  if (
    operation.providerCode !== input.providerCode ||
    operation.accountRef !== input.accountRef ||
    operation.applicationRef !== input.applicationRef ||
    operation.environment !== input.environment
  ) {
    throw new PaymentReliabilityError(
      PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
      'Subscription operation scope does not match the request',
    );
  }
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

function toSubscriptionResult(
  operation: PaymentOperation,
  extras?: Pick<
    SubscriptionResult,
    'subscriptionStateRefreshPending' | 'subscriptionStateRefreshErrorCode'
  >,
): SubscriptionResult {
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
    ...extras,
  };
}

async function markSubscriptionLifecycleCommandSucceeded(
  store: PaymentReliabilityStore,
  commandOp: PaymentOperation,
  kind: string,
): Promise<PaymentOperation> {
  return store.transitionOperation({
    operationId: commandOp.operationId,
    expectedVersion: commandOp.version,
    nextStatus: 'succeeded',
    reason: `PayPal subscription ${kind}`,
  });
}

function throwNormalizedCommandFailure(
  commandOp: PaymentOperation,
  providerDebugId: string | null,
): never {
  const code = (commandOp.failureCode ??
    PAYMENT_RELIABILITY_ERROR.PROVIDER_UNCERTAIN) as PaymentReliabilityErrorCode;
  throw new PaymentReliabilityError(
    code,
    commandOp.failureMessage ?? 'Subscription lifecycle command failed',
    { providerDebugId },
  );
}

type SubscriptionPlanReference =
  | { form: 'plan_operation'; planOperationId: string }
  | { form: 'provider_plan'; providerPlanId: string; offeringRef: string };

type SubscriptionPlanReferenceInput = Pick<
  CreateSubscriptionRequest,
  'planOperationId' | 'providerPlanId' | 'offeringRef'
>;

function resolveSubscriptionPlanReference(
  input: SubscriptionPlanReferenceInput,
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

    const fingerprint = buildSubscriptionCreateCommandFingerprint(input);
    const base = this.subscriptionOperationBase(input, fingerprint);
    await this.assertProviderPlanActiveBeforeCreate(input, base, plan.providerPlanId);

    const operation = await this.store.createOperation({
      ...base,
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
    const fingerprint = buildSubscriptionCreateCommandFingerprint(input);
    const base = this.subscriptionOperationBase(input, fingerprint);
    await this.assertProviderPlanActiveBeforeCreate(input, base, reference.providerPlanId);

    const operation = await this.store.createOperation({
      ...base,
      parentOperationId: null,
      providerPlanId: reference.providerPlanId,
      offeringRef: reference.offeringRef,
    });

    return this.executeSubscriptionOperation(input, operation, reference.providerPlanId);
  }

  /**
   * Both plan reference forms check the provider plan before a new (or still prepared)
   * operation reaches the provider; replays of submitted/unknown/terminal operations return
   * stored state without a provider call.
   */
  private async assertProviderPlanActiveBeforeCreate(
    input: CreateSubscriptionRequest,
    base: ReturnType<SubscriptionLifecycleService['subscriptionOperationBase']>,
    providerPlanId: string,
  ): Promise<void> {
    const existing = await this.store.findOperationByIdempotency(
      base.idempotencyScope,
      base.idempotencyKey,
    );
    if (existing && existing.commandFingerprint !== base.commandFingerprint) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.IDEMPOTENCY_CONFLICT,
        'Idempotency key is already bound to a different command fingerprint',
      );
    }
    if (!existing || existing.status === 'prepared') {
      await this.assertProviderPlanActive(input, providerPlanId);
    }
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
        ...resolveSubscriptionCreateOptions(input),
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

  async retrySubscriptionCreate(
    input: RetrySubscriptionCreateRequest,
    options: SubscriptionCreateRetryOptions,
  ): Promise<SubscriptionResult> {
    let operation = await this.store.findOperationById(input.subscriptionOperationId);
    if (!operation || operation.kind !== 'subscription') {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Subscription operation was not found',
      );
    }
    assertSubscriptionOperationScope(operation, input);

    const fingerprint = buildSubscriptionCreateCommandFingerprint(input);
    if (fingerprint !== operation.commandFingerprint) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.IDEMPOTENCY_CONFLICT,
        'Retry parameters do not match the original subscription command',
      );
    }

    const reference = resolveSubscriptionPlanReference(input);
    if (reference.form === 'plan_operation') {
      if (operation.parentOperationId !== reference.planOperationId) {
        throw new PaymentReliabilityError(
          PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
          'Subscription operation plan reference does not match the request',
        );
      }
    } else if (
      operation.providerPlanId !== reference.providerPlanId ||
      operation.offeringRef !== reference.offeringRef
    ) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Subscription operation plan reference does not match the request',
      );
    }

    if (operation.providerSubscriptionId?.trim()) {
      return toSubscriptionResult(operation);
    }
    if (isTerminal(operation.status)) {
      return toSubscriptionResult(operation);
    }
    if (operation.status !== 'unknown' && operation.status !== 'submitted') {
      if (operation.status === 'prepared') {
        return toSubscriptionResult(operation);
      }
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Subscription operation is not eligible for create retry',
      );
    }

    const providerPlanId = operation.providerPlanId;
    if (!providerPlanId?.trim()) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Subscription operation is missing a provider plan reference',
      );
    }

    if (!this.isSubscriptionExecutionLeaseInFlight(operation)) {
      const firstExecutionAt = await this.resolveFirstSubscriptionProviderExecutionAt(
        operation.operationId,
      );
      const eligibility = options.evaluateProviderCreateRetryEligibility(firstExecutionAt);
      if (eligibility !== 'allowed') {
        return toSubscriptionResult(operation);
      }
    }

    const latest = await this.store.findOperationById(operation.operationId);
    if (!latest || latest.kind !== 'subscription') {
      return toSubscriptionResult(latest ?? operation);
    }
    operation = latest;

    const lease = await this.store.acquireCheckoutCreateExecutionLease({
      operationId: operation.operationId,
      expectedVersion: operation.version,
    });
    if (lease.kind === 'in_flight') {
      return toSubscriptionResult(lease.operation);
    }
    if (lease.kind === 'not_eligible') {
      return toSubscriptionResult(lease.operation);
    }

    return this.executeSubscriptionCreateProviderRetry(
      input,
      lease.operation,
      lease.executionOwnerToken,
      providerPlanId,
    );
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
    execute: (providerSubscriptionId: string) => Promise<ExecuteSubscriptionLifecycleResult>,
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

    let providerResult: ExecuteSubscriptionLifecycleResult;
    try {
      providerResult = await execute(subscription.providerSubscriptionId);
    } catch (error) {
      commandOp = await this.handleFailure(commandOp, error);
      throwNormalizedCommandFailure(commandOp, resolveProviderFailure(error).providerDebugId);
    }

    commandOp = await markSubscriptionLifecycleCommandSucceeded(this.store, commandOp, kind);

    if (isExecuteSubscriptionLifecycleRefreshPending(providerResult)) {
      return toSubscriptionResult(subscription, {
        subscriptionStateRefreshPending: true,
        subscriptionStateRefreshErrorCode: providerResult.subscriptionStateRefreshErrorCode ?? null,
      });
    }

    const currentSubscription = await this.store.findOperationById(subscription.operationId);
    if (!currentSubscription) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Subscription with provider reference was not found',
      );
    }

    try {
      assertSubscriptionProviderPlanSnapshotConsistent(currentSubscription, providerResult);
    } catch (error) {
      if (isSubscriptionProviderPlanMismatchError(error)) {
        return toSubscriptionResult(currentSubscription, {
          subscriptionStateRefreshErrorCode: PAYMENT_RELIABILITY_ERROR.SUBSCRIPTION_PLAN_MISMATCH,
        });
      }
      throw error;
    }

    const updated = await applySubscriptionDomainUpdate(this.store, currentSubscription, {
      subscriptionStatus: providerResult.subscriptionStatus,
      lifecycleReason: providerResult.lifecycleReason ?? input.reason,
      startTime: providerResult.startTime,
      nextBillingTime: providerResult.nextBillingTime,
      providerSubscriptionStateAt: providerResult.providerSubscriptionStateAt ?? null,
      reason: `PayPal subscription ${kind}`,
    });
    return toSubscriptionResult(updated);
  }

  private isSubscriptionExecutionLeaseInFlight(operation: PaymentOperation): boolean {
    if (!operation.executionOwnerToken || !operation.executionLeaseExpiresAt) {
      return false;
    }
    const expiresMs = Date.parse(operation.executionLeaseExpiresAt);
    return Number.isFinite(expiresMs) && Date.now() < expiresMs;
  }

  private async resolveFirstSubscriptionProviderExecutionAt(
    operationId: string,
  ): Promise<string | null> {
    const transitions = await this.store.listOperationTransitions(operationId);
    const executionTransitions = transitions
      .filter(
        (row) =>
          row.toStatus === 'submitted' && row.reason === SUBSCRIPTION_CLAIMED_FOR_EXECUTION_REASON,
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return executionTransitions[0]?.createdAt ?? null;
  }

  private async executeSubscriptionCreateProviderRetry(
    input: RetrySubscriptionCreateRequest,
    operation: PaymentOperation,
    executionOwnerToken: string,
    providerPlanId: string,
  ): Promise<SubscriptionResult> {
    let executingOperation = operation;
    try {
      const result = await this.provider.createSubscription({
        providerCode: input.providerCode,
        accountRef: input.accountRef,
        applicationRef: input.applicationRef,
        environment: input.environment,
        providerRequestId: executingOperation.operationId,
        providerPlanId,
        subscriberEmail: input.subscriber.email ?? null,
        returnUrl: input.returnUrl ?? null,
        cancelUrl: input.cancelUrl ?? null,
        ...resolveSubscriptionCreateOptions(input),
      });
      executingOperation = await this.persistSubscriptionCreateExecutionTransition(
        executingOperation,
        executionOwnerToken,
        {
          nextStatus: subscriptionStatusToOperationStatus(result.subscriptionStatus),
          subscriptionStatus: result.subscriptionStatus,
          providerSubscriptionId: result.providerSubscriptionId,
          providerReferenceId: result.providerSubscriptionId,
          approvalUrl: result.approvalUrl,
          startTime: result.startTime,
          nextBillingTime: result.nextBillingTime,
          reason: 'PayPal subscription created awaiting approval if required',
        },
      );
    } catch (error) {
      executingOperation = await this.handleSubscriptionCreateProviderFailure(
        executingOperation,
        error,
        executionOwnerToken,
      );
    }
    return toSubscriptionResult(executingOperation);
  }

  private isSubscriptionExecutorPersistenceConflict(error: unknown): boolean {
    if (!(error instanceof PaymentReliabilityError)) {
      return false;
    }
    if (error.code === PAYMENT_RELIABILITY_ERROR.TRANSITION_CONFLICT) {
      return true;
    }
    return (
      error.code === PAYMENT_RELIABILITY_ERROR.TRANSITION_REJECTED &&
      error.rejectionReason === PAYMENT_TRANSITION_REJECTION_REASON.EXECUTION_OWNER_MISMATCH
    );
  }

  private async reloadSubscriptionOperationAfterPersistenceConflict(
    operationId: string,
  ): Promise<PaymentOperation> {
    const reloaded = await this.store.findOperationById(operationId);
    if (!reloaded) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.TRANSITION_CONFLICT,
        'Operation was not found after persistence conflict',
      );
    }
    return reloaded;
  }

  private async persistSubscriptionCreateExecutionTransition(
    operation: PaymentOperation,
    executionOwnerToken: string,
    input: Omit<
      Parameters<PaymentReliabilityStore['transitionOperation']>[0],
      | 'operationId'
      | 'expectedVersion'
      | 'expectedExecutionOwnerToken'
      | 'executionOwnerToken'
      | 'executionLeaseExpiresAt'
    >,
  ): Promise<PaymentOperation> {
    try {
      return await this.store.transitionOperation({
        operationId: operation.operationId,
        expectedVersion: operation.version,
        expectedExecutionOwnerToken: executionOwnerToken,
        executionOwnerToken: null,
        executionLeaseExpiresAt: null,
        ...input,
      });
    } catch (error) {
      if (!this.isSubscriptionExecutorPersistenceConflict(error)) {
        throw error;
      }
      return this.reloadSubscriptionOperationAfterPersistenceConflict(operation.operationId);
    }
  }

  private async handleSubscriptionCreateProviderFailure(
    operation: PaymentOperation,
    error: unknown,
    executionOwnerToken?: string | null,
  ): Promise<PaymentOperation> {
    const resolved = resolveProviderFailure(error);
    const nextStatus =
      resolved.code === PAYMENT_RELIABILITY_ERROR.PROVIDER_ACTION_REQUIRED
        ? 'failed'
        : resolved.uncertain || resolved.retryable
          ? 'unknown'
          : isTerminalPreProviderFailureCode(resolved.code) ||
              resolved.code === PAYMENT_RELIABILITY_ERROR.PROVIDER_TERMINAL_REJECTION
            ? 'failed'
            : 'unknown';

    const ownerToken = executionOwnerToken ?? operation.executionOwnerToken;
    const transitionInput = {
      operationId: operation.operationId,
      expectedVersion: operation.version,
      ...(ownerToken
        ? {
            expectedExecutionOwnerToken: ownerToken,
            executionOwnerToken: null,
            executionLeaseExpiresAt: null,
          }
        : {}),
      nextStatus,
      subscriptionStatus: nextStatus === 'unknown' ? 'unknown' : operation.subscriptionStatus,
      failureCode: resolved.code,
      failureMessage: formatProviderFailureMessage(resolved),
      reason: 'Subscription provider mutation returned uncertain or terminal outcome',
    } as Parameters<PaymentReliabilityStore['transitionOperation']>[0];

    try {
      return await this.store.transitionOperation(transitionInput);
    } catch (transitionError) {
      if (ownerToken && this.isSubscriptionExecutorPersistenceConflict(transitionError)) {
        return this.reloadSubscriptionOperationAfterPersistenceConflict(operation.operationId);
      }
      throw transitionError;
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
      failureMessage: formatProviderFailureMessage(resolveProviderFailure(error)),
      reason: 'Subscription provider mutation returned uncertain or terminal outcome',
    });
  }
}
