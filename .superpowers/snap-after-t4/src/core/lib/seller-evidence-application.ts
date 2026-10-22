import type {
  ExecuteGetSellerMerchantStatusResult,
  SellerConnectionRecord,
} from '../../contracts/index';
import { evaluateSellerConnectionReadiness } from './seller-connection-readiness';
import { deriveSellerConnectionStatus } from './seller-transition-policy';
import type { PaymentReliabilityStore } from './persistence/payment-reliability-store';

const REQUIRED_SCOPE_HINTS = ['payments', 'refund'];

export function mapMerchantStatusToConnectionPatch(
  snapshot: ExecuteGetSellerMerchantStatusResult,
  current: SellerConnectionRecord,
): {
  providerMerchantId: string;
  consentStatus: SellerConnectionRecord['consentStatus'];
  paymentsReceivable: boolean | null;
  primaryEmailConfirmed: boolean | null;
  requiredPermissionsGranted: boolean;
  onboardingCompleted: boolean;
  restricted: boolean;
  readinessReady: boolean;
  readinessReasons: string[];
  connectionStatus: SellerConnectionRecord['connectionStatus'];
  normalizedCapabilities: Record<string, boolean>;
} {
  const requiredPermissionsGranted =
    snapshot.grantedScopes.length > 0 &&
    REQUIRED_SCOPE_HINTS.every((hint) =>
      snapshot.grantedScopes.some((scope) => scope.toLowerCase().includes(hint)),
    );
  const restricted =
    snapshot.hasLimitations ||
    snapshot.paymentsReceivable === false ||
    snapshot.productActive === false;
  const consentStatus: SellerConnectionRecord['consentStatus'] =
    current.consentStatus === 'revoked'
      ? 'revoked'
      : snapshot.consentPresent
        ? 'granted'
        : 'missing';
  const onboardingCompleted =
    consentStatus !== 'revoked' &&
    snapshot.paymentsReceivable === true &&
    snapshot.primaryEmailConfirmed === true &&
    requiredPermissionsGranted &&
    snapshot.consentPresent;
  const readiness = evaluateSellerConnectionReadiness({
    providerMerchantId: snapshot.providerMerchantId,
    consentStatus,
    paymentsReceivable: snapshot.paymentsReceivable,
    primaryEmailConfirmed: snapshot.primaryEmailConfirmed,
    requiredPermissionsGranted,
    onboardingCompleted,
    restricted: consentStatus === 'revoked' ? true : restricted,
  });
  return {
    providerMerchantId: snapshot.providerMerchantId,
    consentStatus,
    paymentsReceivable: snapshot.paymentsReceivable,
    primaryEmailConfirmed: snapshot.primaryEmailConfirmed,
    requiredPermissionsGranted,
    onboardingCompleted,
    restricted,
    readinessReady: readiness.ready,
    readinessReasons: readiness.reasons,
    connectionStatus: deriveSellerConnectionStatus({
      consentStatus,
      readinessReady: readiness.ready,
      restricted: consentStatus === 'revoked' ? true : restricted,
      providerMerchantId: snapshot.providerMerchantId,
    }),
    normalizedCapabilities: {
      paymentsReceivable: snapshot.paymentsReceivable === true,
      primaryEmailConfirmed: snapshot.primaryEmailConfirmed === true,
      requiredPermissionsGranted,
      productActive: snapshot.productActive === true,
    },
  };
}

export async function applySellerMerchantStatus(input: {
  store: PaymentReliabilityStore;
  connection: SellerConnectionRecord;
  snapshot: ExecuteGetSellerMerchantStatusResult;
}): Promise<SellerConnectionRecord> {
  const patch = mapMerchantStatusToConnectionPatch(input.snapshot, input.connection);
  return input.store.updateSellerConnection({
    connectionId: input.connection.connectionId,
    expectedVersion: input.connection.version,
    ...patch,
  });
}
