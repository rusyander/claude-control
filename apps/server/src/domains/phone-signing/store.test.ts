import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PhoneSigningStore, activeDevices, parseSigningState } from './store.ts';

/** Файл режима подписи на настоящем диске во временном каталоге. */

let dir = '';
let path = '';
const NOW = 1_800_000_000_000;
const device = (id: string) => ({
  id,
  label: id,
  publicKey: 'A'.repeat(43),
  boundAt: new Date(NOW).toISOString(),
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'phone-signing-'));
  path = join(dir, 'phone-signing.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('PhoneSigningStore', () => {
  it('no file — off, no devices', () => {
    expect(new PhoneSigningStore(path).read()).toEqual({
      version: 1,
      enabled: false,
      devices: [],
      nonces: [],
    });
  });

  it('a nonce is accepted once, and still refused after a restart (new store instance)', () => {
    const store = new PhoneSigningStore(path);
    store.bind(device('a1'));
    expect(store.consumeNonce('a1', 'n1', NOW)).toBe(true);
    expect(store.consumeNonce('a1', 'n1', NOW + 1)).toBe(false);
    expect(new PhoneSigningStore(path).consumeNonce('a1', 'n1', NOW + 2)).toBe(false);
    // Другое устройство с тем же числом — своё число.
    expect(store.consumeNonce('b2', 'n1', NOW + 3)).toBe(true);
    // После срока число забывается — но подпись того времени уже вне окна часов.
    expect(store.consumeNonce('a1', 'n1', NOW + 10 * 60_000 + 1)).toBe(true);
    expect(store.read().devices[0]?.lastUsedAt).toBe(new Date(NOW + 10 * 60_000 + 1).toISOString());
  });

  it('binding is refused while the mode is on; revoking is not', () => {
    const store = new PhoneSigningStore(path);
    expect(store.bind(device('a1'))).toBe('bound');
    expect(store.bind(device('a1'))).toBe('exists');
    store.setMode(true, 'a1', new Date(NOW));
    expect(store.bind(device('b2'))).toBe('enabled');
    expect(store.revoke('a1', new Date(NOW))).toBe(true);
    expect(activeDevices(store.read())).toEqual([]);
    expect(store.read().enabledBy).toBe('a1');
    expect(store.revoke('zz', new Date(NOW))).toBe(false);
  });

  it('a revoked key is never bound again, even with the mode off — the phone makes a new one', () => {
    const store = new PhoneSigningStore(path);
    store.bind(device('a1'));
    store.revoke('a1', new Date(NOW));
    expect(store.bind(device('a1'))).toBe('revoked');
    expect(store.read().devices.find((item) => item.id === 'a1')?.revokedAt).toBeDefined();
    expect(store.bind(device('c3'))).toBe('bound');
  });

  it('a deleted file switches the mode off at once (recovery without a phone)', () => {
    const store = new PhoneSigningStore(path);
    store.bind(device('a1'));
    store.setMode(true, 'a1', new Date(NOW));
    expect(store.read().enabled).toBe(true);
    rmSync(path);
    expect(store.read().enabled).toBe(false);
  });

  it('a corrupt file reads as ON with no devices — damage never switches protection off', () => {
    writeFileSync(path, '{"version":1,"enabled":fal');
    expect(new PhoneSigningStore(path).read()).toMatchObject({
      enabled: true,
      devices: [],
      corrupt: true,
    });
    expect(parseSigningState('{"version":2,"enabled":false}').enabled).toBe(true);
    expect(parseSigningState('{"version":1,"enabled":"no"}').enabled).toBe(true);
    // Испорченный файл бэкенд не перезаписывает отзывом.
    expect(new PhoneSigningStore(path).revoke('a1', new Date(NOW))).toBe(false);
  });
});
