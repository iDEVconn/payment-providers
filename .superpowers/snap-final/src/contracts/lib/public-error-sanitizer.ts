const SENSITIVE_SUBSTRINGS = [
  /client[_-]?secret/i,
  /client[_-]?id/i,
  /authorization:\s*bearer/i,
  /authorization:\s*basic/i,
  /access[_-]?token/i,
  /postgres:\/\//i,
  /\/private\//,
  /\/Users\//,
  /\/home\//,
  /\/var\//,
  /apps\/microservices/,
  /ENOENT|EACCES|ECONNREFUSED|ENOTFOUND|getaddrinfo/i,
];

export function messageContainsSensitiveContent(message: string): boolean {
  return SENSITIVE_SUBSTRINGS.some((pattern) => pattern.test(message));
}

export function sanitizePublicErrorMessage(message: string, fallback: string): string {
  if (!message.trim()) {
    return fallback;
  }
  if (messageContainsSensitiveContent(message)) {
    return fallback;
  }
  return message;
}

export function sanitizeOperationalErrorMessage(error: unknown, fallback: string): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : String(error);
  return sanitizePublicErrorMessage(raw, fallback);
}
