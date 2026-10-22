import { describe, expect, it } from 'vitest';
import {
  validateBillingPlanOperationBinding,
  validateBillingPlanOperationForSubscriptionLifecycle,
} from '../subscription-billing-plan-binding-readiness';

const planOperationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function billingPlan(overrides: Record<string, unknown> = {}) {
  return {
    operationId: planOperationId,
    kind: 'billing_plan',
    environment: 'sandbox',
    offeringRef: 'campaign_creator_individual_monthly_v1',
    providerPlanId: 'PLAN-PROVIDER-1',
    planStatus: 'active',
    status: 'succeeded',
    ...overrides,
  } as never;
}

describe('validateBillingPlanOperationForSubscriptionLifecycle', () => {
  it('accepts succeeded operation with provider plan evidence', () => {
    expect(validateBillingPlanOperationForSubscriptionLifecycle(billingPlan())).toBe('ready');
  });

  it('accepts submitted operation when provider plan evidence exists', () => {
    expect(
      validateBillingPlanOperationForSubscriptionLifecycle(billingPlan({ status: 'submitted' })),
    ).toBe('ready');
  });

  it('accepts unknown operation when provider plan evidence exists', () => {
    expect(
      validateBillingPlanOperationForSubscriptionLifecycle(billingPlan({ status: 'unknown' })),
    ).toBe('ready');
  });

  it('rejects failed operation without provider plan evidence', () => {
    expect(
      validateBillingPlanOperationForSubscriptionLifecycle(
        billingPlan({ status: 'failed', providerPlanId: null }),
      ),
    ).toBe('not_ready');
  });

  it('rejects wrong kind and missing provider plan evidence', () => {
    expect(
      validateBillingPlanOperationForSubscriptionLifecycle(
        billingPlan({ kind: 'catalog_product' }),
      ),
    ).toBe('not_ready');
    expect(
      validateBillingPlanOperationForSubscriptionLifecycle(billingPlan({ providerPlanId: null })),
    ).toBe('not_ready');
  });
});

describe('validateBillingPlanOperationBinding', () => {
  it('accepts a ready billing plan operation', () => {
    expect(
      validateBillingPlanOperationBinding(billingPlan(), {
        expectedEnvironment: 'sandbox',
        expectedOfferingRef: 'campaign_creator_individual_monthly_v1',
      }),
    ).toBe('ready');
  });

  it('rejects missing operation', () => {
    expect(
      validateBillingPlanOperationBinding(null, {
        expectedEnvironment: 'sandbox',
        expectedOfferingRef: 'campaign_creator_individual_monthly_v1',
      }),
    ).toBe('not_ready');
  });

  it('rejects wrong kind', () => {
    expect(
      validateBillingPlanOperationBinding(billingPlan({ kind: 'catalog_product' }), {
        expectedEnvironment: 'sandbox',
        expectedOfferingRef: 'campaign_creator_individual_monthly_v1',
      }),
    ).toBe('not_ready');
  });

  it('rejects wrong offering reference', () => {
    expect(
      validateBillingPlanOperationBinding(
        billingPlan({ offeringRef: 'campaign_creator_company_monthly_v1' }),
        {
          expectedEnvironment: 'sandbox',
          expectedOfferingRef: 'campaign_creator_individual_monthly_v1',
        },
      ),
    ).toBe('not_ready');
  });

  it('rejects wrong environment', () => {
    expect(
      validateBillingPlanOperationBinding(billingPlan({ environment: 'sandbox' }), {
        expectedEnvironment: 'live',
        expectedOfferingRef: 'campaign_creator_individual_monthly_v1',
      }),
    ).toBe('not_ready');
  });

  it('rejects missing provider plan evidence', () => {
    expect(
      validateBillingPlanOperationBinding(billingPlan({ providerPlanId: null }), {
        expectedEnvironment: 'sandbox',
        expectedOfferingRef: 'campaign_creator_individual_monthly_v1',
      }),
    ).toBe('not_ready');
  });

  it('rejects created plan status for customer binding', () => {
    expect(
      validateBillingPlanOperationBinding(billingPlan({ planStatus: 'created' }), {
        expectedEnvironment: 'sandbox',
        expectedOfferingRef: 'campaign_creator_individual_monthly_v1',
      }),
    ).toBe('not_ready');
  });
});
