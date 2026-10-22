import { PAYMENT_RELIABILITY_ERROR, PaymentReliabilityError } from '../../contracts/index';
import type { BillingCycleInput } from '../../contracts/index';
import { validateCanonicalMoney } from './money';

export function validateBillingCycles(cycles: BillingCycleInput[]): BillingCycleInput[] {
  if (cycles.length === 0) {
    throw new PaymentReliabilityError(
      PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
      'Billing plan must contain at least one billing cycle',
    );
  }

  const trialCycles = cycles.filter((cycle) => cycle.tenureType === 'TRIAL');
  const regularCycles = cycles.filter((cycle) => cycle.tenureType === 'REGULAR');

  if (trialCycles.length > 2) {
    throw new PaymentReliabilityError(
      PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
      'Billing plan may contain at most two trial cycles',
    );
  }
  if (regularCycles.length !== 1) {
    throw new PaymentReliabilityError(
      PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
      'Billing plan must contain exactly one regular cycle',
    );
  }

  const sequences = new Set<number>();
  for (const cycle of cycles) {
    if (cycle.sequence < 1 || cycle.intervalCount < 1) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Billing cycle sequence and interval count must be positive',
      );
    }
    if (!Number.isInteger(cycle.totalCycles)) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Billing cycle total cycles must be an integer',
      );
    }
    if (cycle.totalCycles < 0) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Billing cycle total cycles cannot be negative',
      );
    }
    if (cycle.tenureType === 'TRIAL' && cycle.totalCycles < 1) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Trial billing cycles must repeat at least once',
      );
    }
    if (sequences.has(cycle.sequence)) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Billing cycle sequences must be unique',
      );
    }
    sequences.add(cycle.sequence);
    if (cycle.tenureType === 'REGULAR' && !cycle.price) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Regular billing cycle must have a price',
      );
    }
    if (cycle.price) {
      // A free trial may carry a zero price; the regular cycle must always charge.
      validateCanonicalMoney(cycle.price, { allowZero: cycle.tenureType === 'TRIAL' });
    }
  }

  const sorted = [...cycles].sort((a, b) => a.sequence - b.sequence);
  for (let index = 1; index < sorted.length; index += 1) {
    if ((sorted[index]?.sequence ?? 0) <= (sorted[index - 1]?.sequence ?? 0)) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Billing cycle sequences must be strictly increasing',
      );
    }
  }

  sorted.forEach((cycle, index) => {
    if (cycle.sequence !== index + 1) {
      throw new PaymentReliabilityError(
        PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
        'Billing cycle sequences must be contiguous and start at 1',
      );
    }
  });
  if (sorted.findIndex((cycle) => cycle.tenureType === 'REGULAR') !== sorted.length - 1) {
    throw new PaymentReliabilityError(
      PAYMENT_RELIABILITY_ERROR.INVALID_REQUEST,
      'Trial billing cycles must come before the regular billing cycle',
    );
  }

  return sorted;
}
