import { missingEnv } from './host-env-banner';
import type { CapabilityAvailability, PaymentAccountContext } from '../../contracts/index';
import { CAPABILITY_DEFINITIONS, type CapabilityDefinition } from './capability-definitions';
import { type EnvGetter, readEnvEnabled } from './env-access';

function unavailableReasonFor(
  definition: CapabilityDefinition,
  row: Omit<CapabilityAvailability, 'ready' | 'unavailableReason'>,
): string {
  if (!definition.implemented) {
    return 'Capability is not implemented in this release';
  }
  if (!row.enabled) {
    return 'Capability is disabled by configuration';
  }
  if (!row.configured) {
    return 'Required configuration values are missing';
  }
  if (row.eligible === false) {
    return 'Provider or account is not eligible for this capability';
  }
  return 'Capability is not ready';
}

function evaluateEligible(
  definition: CapabilityDefinition,
  enabled: boolean,
  configured: boolean,
): boolean | 'unknown' {
  if (!definition.implemented || !enabled || !configured) {
    return false;
  }
  return 'unknown';
}

function evaluateConfigured(
  definition: CapabilityDefinition,
  enabled: boolean,
  get: EnvGetter,
): boolean {
  if (!enabled) {
    return true;
  }
  if (definition.requiredEnvKeys.length === 0) {
    return true;
  }
  return missingEnv(get, definition.requiredEnvKeys).length === 0;
}

export function evaluateCapabilities(
  get: EnvGetter,
  context: PaymentAccountContext,
): CapabilityAvailability[] {
  void context;
  return CAPABILITY_DEFINITIONS.map((definition) => {
    const enabled = readEnvEnabled(get, definition.enabledEnvKey, definition.defaultEnabled);
    const configured = evaluateConfigured(definition, enabled, get);
    const implemented = definition.implemented;
    const eligible = evaluateEligible(definition, enabled, configured);
    const ready = implemented && enabled && configured && eligible !== false;
    const row = {
      capability: definition.capability,
      implemented,
      enabled,
      configured,
      eligible,
    };
    return {
      ...row,
      ready,
      unavailableReason: ready ? undefined : unavailableReasonFor(definition, row),
    };
  });
}

export function findCapabilityAvailability(
  capabilities: CapabilityAvailability[],
  capability: CapabilityAvailability['capability'],
): CapabilityAvailability | undefined {
  return capabilities.find((row) => row.capability === capability);
}
