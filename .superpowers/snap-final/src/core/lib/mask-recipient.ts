import type { PayoutRecipientType } from '../../contracts/index';

export function maskRecipientValue(recipientType: PayoutRecipientType, receiver: string): string {
  const trimmed = receiver.trim();
  if (!trimmed) {
    return '***';
  }
  if (recipientType === 'EMAIL') {
    const [localPart, domain] = trimmed.split('@');
    if (!domain || !localPart) {
      return '***';
    }
    const visible = localPart.slice(0, Math.min(2, localPart.length));
    return `${visible}***@${domain}`;
  }
  if (recipientType === 'PHONE') {
    const digits = trimmed.replace(/\D/g, '');
    const tail = digits.slice(-4);
    return tail ? `***${tail}` : '***';
  }
  if (recipientType === 'PAYPAL_ID') {
    const head = trimmed.slice(0, 4);
    const tail = trimmed.slice(-2);
    return `${head}***${tail}`;
  }
  return '***';
}
