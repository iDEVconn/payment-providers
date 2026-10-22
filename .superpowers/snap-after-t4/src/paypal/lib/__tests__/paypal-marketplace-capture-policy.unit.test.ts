import { describe, expect, it } from 'vitest';
import { classifyPaypalMarketplaceCapture422 } from '../paypal-marketplace-capture-policy';

describe('classifyPaypalMarketplaceCapture422', () => {
  it('treats responses with capture ids as partial_with_captures', () => {
    expect(
      classifyPaypalMarketplaceCapture422({
        purchase_units: [{ payments: { captures: [{ id: 'CAP-1' }] } }],
      }).kind,
    ).toBe('partial_with_captures');
  });

  it('maps known pre-capture validation issues to terminal_pre_capture', () => {
    const result = classifyPaypalMarketplaceCapture422({
      details: [{ issue: 'ORDER_NOT_APPROVED' }],
    });
    expect(result).toEqual({
      kind: 'terminal_pre_capture',
      issueCodes: ['ORDER_NOT_APPROVED'],
    });
  });

  it('maps per-unit payment issues to uncertain', () => {
    const result = classifyPaypalMarketplaceCapture422({
      details: [{ issue: 'INSTRUMENT_DECLINED' }],
    });
    expect(result).toEqual({
      kind: 'uncertain',
      issueCodes: ['INSTRUMENT_DECLINED'],
    });
  });

  it('treats unknown issue codes as uncertain', () => {
    const result = classifyPaypalMarketplaceCapture422({
      details: [{ issue: 'SOME_NEW_ISSUE' }],
    });
    expect(result.kind).toBe('uncertain');
  });

  it('treats empty issue details as uncertain', () => {
    expect(classifyPaypalMarketplaceCapture422({}).kind).toBe('uncertain');
  });
});
