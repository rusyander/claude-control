import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { ensureCoreHome } from '../platform/core-home.ts';
import { loadSigningDevices } from './devices.ts';

/**
 * Отзыв устройства не теряется из-за формы файла (ревью F-108): дубль id с поздним отзывом —
 * отозвано; `revokedAt` есть, но не строка (0, null, false) — отозвано, а не «активно».
 */

describe('signing devices: revocation is fail-closed', () => {
  it('F-108 a later revoked duplicate revokes the id; a present non-string revokedAt counts as revoked', () => {
    const layout = ensureCoreHome(join(tempDir('home-'), 'core'));
    writeFileSync(
      join(layout.root, 'devices.json'),
      JSON.stringify({
        devices: [
          { id: 'dup', publicKey: 'pk1' },
          { id: 'dup', publicKey: 'pk1', revokedAt: '2026-10-01T00:00:00Z' },
          { id: 'zero', publicKey: 'pk2', revokedAt: 0 },
          { id: 'nul', publicKey: 'pk3', revokedAt: null },
          { id: 'no', publicKey: 'pk4', revokedAt: false },
          { id: 'two-keys', publicKey: 'pk5' },
          { id: 'two-keys', publicKey: 'pk6' },
          { id: 'ok', publicKey: 'pk7' },
        ],
      }),
    );
    const byId = new Map(loadSigningDevices(layout).map((d) => [d.id, d]));
    for (const id of ['dup', 'zero', 'nul', 'no', 'two-keys']) {
      expect({ id, revoked: Boolean(byId.get(id)?.revokedAt) }).toEqual({ id, revoked: true });
    }
    expect(byId.get('ok')).toEqual({ id: 'ok', publicKey: 'pk7' });
    expect(loadSigningDevices(layout).filter((d) => d.id === 'dup')).toHaveLength(1);
  });
});
