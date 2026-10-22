import { createHash } from 'node:crypto';

export function sha256Payload(rawPayload: string): string {
  return createHash('sha256').update(rawPayload, 'utf8').digest('hex');
}
