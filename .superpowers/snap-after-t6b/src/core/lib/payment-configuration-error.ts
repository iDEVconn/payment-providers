export class PaymentConfigurationError extends Error {
  readonly missingFields: string[];

  constructor(message: string, missingFields: string[] = []) {
    super(message);
    this.name = 'PaymentConfigurationError';
    this.missingFields = missingFields;
  }
}

export function missingStringFields(
  values: Record<string, string | undefined>,
  keys: string[],
): string[] {
  return keys.filter((key) => !values[key]?.trim());
}

export function requireApplicationRef(value: string | undefined | null): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new PaymentConfigurationError('Payment applicationRef is required', ['applicationRef']);
  }
  return trimmed;
}

export function formatConfigurationIssue(opts: {
  headline: string;
  missingFields?: string[];
  reason?: string;
}): string {
  const lines: string[] = [opts.headline, ''];
  if (opts.missingFields && opts.missingFields.length > 0) {
    lines.push('Required configuration is missing or invalid:');
    for (const field of opts.missingFields) {
      lines.push(`  • ${field}`);
    }
  } else if (opts.reason) {
    lines.push(opts.reason);
  }
  lines.push('');
  lines.push('Provide configuration explicitly at the application composition root.');
  return boxed(lines);
}

function boxed(lines: string[]): string {
  const width = Math.max(...lines.map((l) => l.length), 50);
  const top = `╔═${'═'.repeat(width)}═╗`;
  const bot = `╚═${'═'.repeat(width)}═╝`;
  const body = lines.map((l) => `║ ${l.padEnd(width)} ║`).join('\n');
  return `\n${top}\n${body}\n${bot}`;
}
