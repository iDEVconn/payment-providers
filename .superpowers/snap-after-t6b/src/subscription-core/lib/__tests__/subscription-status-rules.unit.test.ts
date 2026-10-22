import { describe, expect, it } from 'vitest';
import type { SubscriptionStatus } from '../../../contracts/lib/subscription';
import {
  compareProviderStateTimestamps,
  evaluateSubscriptionStateOrdering,
  isFreshTransmission,
  isSubscriptionStatusTransitionAllowed,
  parseProviderTimestamp,
} from '../subscription-status-rules';

describe('parseProviderTimestamp', () => {
  it.each([
    ['2026-10-22T10:00:00Z', '2026-10-22T10:00:00.000Z'],
    ['2026-10-22T10:00:00.123Z', '2026-10-22T10:00:00.123Z'],
    ['2026-10-22T12:00:00+02:00', '2026-10-22T10:00:00.000Z'],
    ['2026-10-22T05:30:00-0430', '2026-10-22T10:00:00.000Z'],
    ['2026-10-22T10:00Z', '2026-10-22T10:00:00.000Z'],
    ['2026-10-22', '2026-10-22T00:00:00.000Z'],
    ['2024-02-29T00:00:00Z', '2024-02-29T00:00:00.000Z'],
    ['2026-12-31T23:59:59Z', '2026-12-31T23:59:59.000Z'],
  ])('%s -> %s', (input, expected) => {
    expect(parseProviderTimestamp(input)).toBe(expected);
  });

  it.each([
    '2026-02-30T00:00:00Z',
    '2026-02-29T00:00:00Z',
    '2026-04-31',
    '2026-13-01T00:00:00Z',
    '2026-00-10T00:00:00Z',
    '2026-10-00T00:00:00Z',
    '2026-10-22T24:00:00Z',
    '2026-10-22T10:60:00Z',
    '2026-10-22T10:00:60Z',
    '2026-10-22T10:00:00+24:00',
    '2026-10-22T10:00:00+05:60',
    '2026-10-22T10:00:00',
    '1',
    'garbage',
    '',
  ])('rejects %j', (input) => {
    expect(parseProviderTimestamp(input)).toBeNull();
  });

  it('an impossible transmission time is never fresh', () => {
    expect(isFreshTransmission('2026-02-30T00:00:00Z', Date.parse('2026-03-02T00:00:00Z'), 60_000)).toBe(
      false,
    );
  });
});

describe('ordering helpers treat an unparseable incoming time as missing', () => {
  const stored = '2026-10-22T10:00:00.000Z';

  it('compareProviderStateTimestamps never lets garbage win', () => {
    expect(compareProviderStateTimestamps(stored, 'garbage')).toBe('older');
    expect(compareProviderStateTimestamps(stored, '2026-02-30T00:00:00Z')).toBe('older');
    expect(compareProviderStateTimestamps(stored, '2026-10-22T11:00:00Z')).toBe('newer');
    expect(compareProviderStateTimestamps('garbage', '2026-10-22T11:00:00Z')).toBe('newer');
  });

  it('evaluateSubscriptionStateOrdering never stores garbage as the watermark', () => {
    const base = {
      currentStatus: 'active' as SubscriptionStatus,
      desiredStatus: 'suspended' as SubscriptionStatus,
      authoritative: false,
    };
    expect(
      evaluateSubscriptionStateOrdering({ ...base, storedStateAt: stored, incomingStateAt: 'garbage' }),
    ).toEqual({ action: 'noop', reason: 'missing_timestamp' });
    expect(
      evaluateSubscriptionStateOrdering({ ...base, storedStateAt: null, incomingStateAt: 'garbage' }),
    ).toEqual({ action: 'apply', stateAt: null });
    expect(
      evaluateSubscriptionStateOrdering({
        ...base,
        storedStateAt: null,
        incomingStateAt: '2026-10-22T12:00:00+02:00',
      }),
    ).toEqual({ action: 'apply', stateAt: stored });
  });
});

describe('isSubscriptionStatusTransitionAllowed', () => {
  it.each<[SubscriptionStatus, SubscriptionStatus, boolean]>([
    ['approval_pending', 'approved', true],
    ['approved', 'active', true],
    ['active', 'approved', false],
    ['suspended', 'approved', false],
    ['active', 'approval_pending', false],
    ['suspended', 'approval_pending', false],
    ['approved', 'approval_pending', false],
    ['cancelled', 'active', false],
    ['expired', 'approved', false],
    ['active', 'suspended', true],
    ['suspended', 'active', true],
    ['unknown', 'approved', true],
  ])('%s -> %s: %s', (current, next, allowed) => {
    expect(isSubscriptionStatusTransitionAllowed(current, next)).toBe(allowed);
  });
});
