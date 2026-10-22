import type { PaymentOperationTransitionRecord } from '../../contracts/index';

/**
 * Whether a history row is the first claim of an operation for a provider call. Uses the typed
 * `transitionKind`; for rows without a known kind (older rows, stores that do not record it, or an
 * unexpected value from a host mapping) the structural `prepared -> submitted` move. Never reads
 * the free-text `reason` (issue #23).
 */
export function isProviderExecutionClaimTransition(row: PaymentOperationTransitionRecord): boolean {
  if (row.transitionKind === 'claim_execution') {
    return true;
  }
  if (row.transitionKind === 'claim_retry') {
    return false;
  }
  return row.fromStatus === 'prepared' && row.toStatus === 'submitted';
}

/** `createdAt` of the earliest provider execution claim, or `null` when there is none. */
export function resolveFirstProviderExecutionAt(
  transitions: ReadonlyArray<PaymentOperationTransitionRecord>,
): string | null {
  const claims = transitions
    .filter(isProviderExecutionClaimTransition)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return claims[0]?.createdAt ?? null;
}
