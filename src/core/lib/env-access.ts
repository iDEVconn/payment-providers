export type EnvGetter = (key: string) => string | undefined;

export function readEnvEnabled(get: EnvGetter, key: string, defaultEnabled: boolean): boolean {
  const raw = get(key)?.trim().toLowerCase();
  if (!raw) {
    return defaultEnabled;
  }
  if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') {
    return false;
  }
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

export function readPaymentEnvironment(get: EnvGetter): 'sandbox' | 'live' {
  const raw = get('PAYPAL_ENVIRONMENT')?.trim().toLowerCase();
  if (!raw || raw === 'sandbox') {
    return 'sandbox';
  }
  if (raw === 'live') {
    return 'live';
  }
  throw new Error(`Unsupported PAYPAL_ENVIRONMENT: ${get('PAYPAL_ENVIRONMENT')}`);
}
