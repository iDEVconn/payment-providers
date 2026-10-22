import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256Payload as fromMemoryStore } from '../persistence/memory-payment-reliability-store';
import { sha256Payload } from '../sha256-payload';

function productionSources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return entry === '__tests__' ? [] : productionSources(path);
    }
    return path.endsWith('.ts') ? [path] : [];
  });
}

describe('sha256Payload', () => {
  it('hashes utf-8 text as lowercase hex sha256', () => {
    expect(sha256Payload('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Payload('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('stays re-exported from the memory store for compatibility', () => {
    expect(fromMemoryStore).toBe(sha256Payload);
  });

  it('is not imported from the in-memory store by production code', () => {
    const offenders = productionSources(join(__dirname, '..', '..', '..')).filter((file) => {
      if (file.endsWith('memory-payment-reliability-store.ts') || file.endsWith('core/index.ts')) {
        return false;
      }
      const source = readFileSync(file, 'utf8');
      return /import\s*{[^}]*\bsha256Payload\b[^}]*}\s*from\s*'[^']*memory-payment-reliability-store'/.test(
        source,
      );
    });
    expect(offenders).toEqual([]);
  });
});
