import type { CapabilityAvailability, PaymentAccountContext } from '../../contracts/index';
import { CAPABILITY_DEFINITIONS, type CapabilityDefinition } from './capability-definitions';
import type { PaymentProviderConfig } from './payment-provider-config';

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

function flagKeyForCapability(
  capability: CapabilityDefinition['capability'],
): keyof NonNullable<PaymentProviderConfig['capabilityFlags']> | null {
  if (capability === 'marketplace_checkout') {
    return 'marketplace_checkout';
  }
  if (
    capability === 'checkout' ||
    capability === 'refund' ||
    capability === 'payout' ||
    capability === 'subscription' ||
    capability === 'seller_onboarding'
  ) {
    return capability;
  }
  return null;
}

function isCapabilityEnabled(
  definition: CapabilityDefinition,
  config: PaymentProviderConfig,
): boolean {
  const key = flagKeyForCapability(definition.capability);
  if (key && config.capabilityFlags?.[key] !== undefined) {
    return config.capabilityFlags[key] === true;
  }
  return definition.defaultEnabled;
}

function hasCheckoutCredentials(config: PaymentProviderConfig): boolean {
  return Boolean(
    config.credentials?.clientId?.trim() && config.credentials?.clientSecret?.trim(),
  );
}

function evaluateConfigured(definition: CapabilityDefinition, config: PaymentProviderConfig): boolean {
  if (!isCapabilityEnabled(definition, config)) {
    return true;
  }
  if (definition.requiredEnvKeys.length === 0) {
    return true;
  }

  switch (definition.capability) {
    case 'checkout':
    case 'refund':
    case 'payout':
    case 'subscription':
      return hasCheckoutCredentials(config);
    case 'seller_onboarding':
      return (
        hasCheckoutCredentials(config) &&
        Boolean(
          config.partner?.merchantId?.trim() &&
            config.partner?.attributionId?.trim() &&
            config.partner?.sellerOnboardingReturnUrl?.trim(),
        )
      );
    case 'marketplace_checkout':
      return (
        hasCheckoutCredentials(config) &&
        Boolean(config.partner?.merchantId?.trim() && config.partner?.attributionId?.trim())
      );
    default:
      return true;
  }
}

export function evaluateCapabilities(
  config: PaymentProviderConfig,
  context: PaymentAccountContext,
): CapabilityAvailability[] {
  void context;
  return CAPABILITY_DEFINITIONS.map((definition) => {
    const enabled = isCapabilityEnabled(definition, config);
    const configured = evaluateConfigured(definition, config);
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
