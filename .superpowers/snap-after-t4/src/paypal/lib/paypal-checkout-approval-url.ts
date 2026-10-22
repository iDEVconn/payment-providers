import type { PaymentEnvironment } from '../../contracts/index';

const SANDBOX_APPROVAL_HOSTS = new Set(['www.sandbox.paypal.com', 'sandbox.paypal.com']);
const LIVE_APPROVAL_HOSTS = new Set(['www.paypal.com', 'paypal.com']);

const API_HOSTS = new Set([
  'api-m.paypal.com',
  'api-m.sandbox.paypal.com',
  'api.paypal.com',
  'api.sandbox.paypal.com',
]);

export function isAllowedPaypalApprovalUrl(href: string, environment: PaymentEnvironment): boolean {
  try {
    const url = new URL(href);
    if (url.protocol !== 'https:') {
      return false;
    }
    if (API_HOSTS.has(url.hostname)) {
      return false;
    }
    const allowed = environment === 'live' ? LIVE_APPROVAL_HOSTS : SANDBOX_APPROVAL_HOSTS;
    return allowed.has(url.hostname);
  } catch {
    return false;
  }
}

export function extractPaypalCheckoutApprovalUrl(
  links: unknown,
  environment: PaymentEnvironment,
): string | null {
  if (!Array.isArray(links)) {
    return null;
  }
  for (const rel of ['payer-action', 'approve'] as const) {
    const match = links.find(
      (link) =>
        typeof link === 'object' &&
        link &&
        (link as { rel?: string }).rel === rel &&
        typeof (link as { href?: string }).href === 'string',
    ) as { href?: string } | undefined;
    if (match?.href && isAllowedPaypalApprovalUrl(match.href, environment)) {
      return match.href;
    }
  }
  return null;
}
