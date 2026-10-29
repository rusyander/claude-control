import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { isUuidv7 } from '@agentdeck/contracts/core/ids';
import { ensureCoreHome } from '../platform/core-home.ts';
import { loadSigningDevices, machineIdOf } from './devices.ts';

/**
 * 06 §Authority (b): подпись телефона доказывает человека, только если устройство в списке
 * `<core home>/devices.json` и не отозвано. Испорченный или чужой список — ни одного
 * устройства (подпись не пройдёт), а не «все» и не авария загрузки. Номер машины создаётся
 * один раз и дальше не меняется: он входит в подписанное сообщение.
 */

describe('signing devices and machine id', () => {
  it('machine-id is created once, exclusively, and read back the same on every boot', () => {
    const layout = ensureCoreHome(join(tempDir('home-'), 'core'));
    const first = machineIdOf(layout);
    expect(isUuidv7(first)).toBe(true);
    expect(machineIdOf(layout)).toBe(first);
    expect(readFileSync(join(layout.root, 'machine-id'), 'utf8')).toBe(`${first}\n`);
  });

  it('m3 an empty machine-id left by a crash after the wx create is replaced by a fresh id, never used as ""', () => {
    const layout = ensureCoreHome(join(tempDir('home-'), 'core'));
    writeFileSync(join(layout.root, 'machine-id'), ' \n');
    const id = machineIdOf(layout);
    expect(isUuidv7(id)).toBe(true);
    expect(readFileSync(join(layout.root, 'machine-id'), 'utf8')).toBe(`${id}\n`);
    expect(machineIdOf(layout)).toBe(id);
  });

  it('devices.json: valid entries kept with revocation, malformed entries dropped, broken files give none', () => {
    const layout = ensureCoreHome(join(tempDir('home-'), 'core'));
    const file = join(layout.root, 'devices.json');
    expect(loadSigningDevices(layout)).toEqual([]);
    writeFileSync(
      file,
      JSON.stringify({
        devices: [
          { id: 'phone', publicKey: 'pk1' },
          { id: 'old', publicKey: 'pk2', revokedAt: '2026-10-01T00:00:00Z' },
          { id: 'no-key' },
          { publicKey: 'no-id' },
          { id: 7, publicKey: 'pk3' },
          null,
          'phone',
        ],
      }),
    );
    expect(loadSigningDevices(layout)).toEqual([
      { id: 'phone', publicKey: 'pk1' },
      { id: 'old', publicKey: 'pk2', revokedAt: '2026-10-01T00:00:00Z' },
    ]);
    for (const broken of ['{not json', 'null', '[]', '"devices"', '{"devices":{}}', '{}']) {
      writeFileSync(file, broken);
      expect({ broken, devices: loadSigningDevices(layout) }).toEqual({ broken, devices: [] });
    }
  });
});
