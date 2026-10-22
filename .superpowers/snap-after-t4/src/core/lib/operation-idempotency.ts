import type { PaymentEnvironment } from '../../contracts/index';
import type { PaymentOperationKind } from '../../contracts/index';

export type OperationScopeInput = {
  applicationRef: string;
  accountRef: string;
  environment: PaymentEnvironment;
  kind: PaymentOperationKind;
};

export function buildOperationIdempotencyScope(input: OperationScopeInput): string {
  return `${input.applicationRef}::${input.accountRef}::${input.environment}::${input.kind}`;
}

export function buildProviderEventScope(input: {
  providerCode: string;
  accountRef: string;
  environment: PaymentEnvironment;
}): string {
  return `${input.providerCode}::${input.accountRef}::${input.environment}`;
}
