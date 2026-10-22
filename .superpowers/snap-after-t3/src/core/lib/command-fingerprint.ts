import { createHash } from 'node:crypto';

export function buildCommandFingerprint(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
