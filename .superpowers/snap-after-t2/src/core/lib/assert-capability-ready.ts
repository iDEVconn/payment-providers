import {
  PaymentCapabilityError,
  type CapabilityAvailability,
  type PaymentCapability,
} from '../../contracts/index';
import { findCapabilityAvailability } from './evaluate-capabilities';

export function assertCapabilityReady(
  capabilities: CapabilityAvailability[],
  capability: PaymentCapability,
): void {
  const row = findCapabilityAvailability(capabilities, capability);
  if (!row) {
    throw new PaymentCapabilityError(capability, 'Capability is not registered');
  }
  if (row.ready) {
    return;
  }
  throw new PaymentCapabilityError(capability, row.unavailableReason ?? 'Capability is not ready');
}
