import { describe, expect, it } from 'vitest';
import {
  CHECKOUT_CREATE_IN_FLIGHT_SAFETY_BUFFER_MS,
  evaluateCheckoutCreateExecutionClaimState,
  resolveCheckoutCreateEndToEndRequestTimeoutMs,
} from '../checkout-create-execution-claim';

describe('evaluateCheckoutCreateExecutionClaimState', () => {
  const claimAt = '2026-06-01T12:00:00.000Z';
  const requestTimeoutMs = 1_000;

  it('treats recent claims as in flight', () => {
    const nowMs =
      Date.parse(claimAt) +
      resolveCheckoutCreateEndToEndRequestTimeoutMs(requestTimeoutMs) +
      CHECKOUT_CREATE_IN_FLIGHT_SAFETY_BUFFER_MS -
      1;
    expect(evaluateCheckoutCreateExecutionClaimState(claimAt, requestTimeoutMs, nowMs)).toBe(
      'in_flight',
    );
  });

  it('allows reclaim after the end-to-end timeout and safety buffer', () => {
    const nowMs =
      Date.parse(claimAt) +
      resolveCheckoutCreateEndToEndRequestTimeoutMs(requestTimeoutMs) +
      CHECKOUT_CREATE_IN_FLIGHT_SAFETY_BUFFER_MS +
      1;
    expect(evaluateCheckoutCreateExecutionClaimState(claimAt, requestTimeoutMs, nowMs)).toBe(
      'reclaimable',
    );
  });

  it('returns unavailable when claim timing is missing', () => {
    expect(evaluateCheckoutCreateExecutionClaimState(null, requestTimeoutMs)).toBe('unavailable');
  });
});
