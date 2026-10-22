/**
 * @deprecated The engine maps provider snapshots with `subscriptionEventFromProviderSnapshot` and
 * the pure reducer. Kept for existing callers.
 */
export function subscriptionBillingFieldsFromProviderSnapshot(snapshot: {
  startTime?: string | null;
  nextBillingTime?: string | null;
}): { startTime?: string; nextBillingTime?: string } {
  const fields: { startTime?: string; nextBillingTime?: string } = {};
  if (snapshot.startTime != null && snapshot.startTime !== '') {
    fields.startTime = snapshot.startTime;
  }
  if (snapshot.nextBillingTime != null && snapshot.nextBillingTime !== '') {
    fields.nextBillingTime = snapshot.nextBillingTime;
  }
  return fields;
}
