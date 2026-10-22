export function maskSubscriberEmail(email: string): string {
  const trimmed = email.trim();
  const [localPart, domain] = trimmed.split('@');
  if (!domain || !localPart) {
    return '***';
  }
  const visible = localPart.slice(0, Math.min(2, localPart.length));
  return `${visible}***@${domain}`;
}

export function maskSubscriberRef(subscriberRef: string): string {
  const trimmed = subscriberRef.trim();
  if (!trimmed) {
    return '***';
  }
  const head = trimmed.slice(0, 4);
  const tail = trimmed.slice(-2);
  return `${head}***${tail}`;
}
