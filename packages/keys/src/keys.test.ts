import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isKeysError } from './errors.ts';
import {
  MAX_KEY_LENGTH,
  clearStoredKey,
  getStoredKey,
  hasStoredKey,
  maskKey,
  readKeyPresence,
  readKeyStore,
  readKeyStrict,
  setStoredKey,
} from './provider-keys.ts';
import {
  decryptSecret,
  encryptSecret,
  isEncryptedBackup,
  makeVerifier,
  verifyPassphrase,
} from './secret-crypto.ts';

/**
 * Пакет ключей: коды ошибок вместо русских текстов и СТРОГОЕ чтение, которое отличает «ключа
 * нет» от «хранилище не прочитано». Снисходительное чтение панели проверяют её тесты старого
 * пути (`apps/server/src/lib/provider-keys`, `lib/secret-crypto`) через фасады.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'keys-pkg-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return isKeysError(error) ? error.code : `uncoded: ${String(error)}`;
  }
  return undefined;
}

describe('keys package', () => {
  describe('secret-crypto coded errors', () => {
    it('roundtrip returns the plaintext', () => {
      expect(decryptSecret(encryptSecret('секрет', 'p'), 'p')).toBe('секрет');
    });

    it('a blob without the format mark → not-encrypted', () => {
      expect(codeOf(() => decryptSecret(Buffer.from('plain'), 'p'))).toBe('not-encrypted');
    });

    it('a wrong passphrase → decrypt-failed', () => {
      expect(codeOf(() => decryptSecret(encryptSecret('x', 'right'), 'wrong'))).toBe(
        'decrypt-failed',
      );
    });

    it('verifier matches only its passphrase; a malformed verifier is a mismatch, not a throw', () => {
      const verifier = makeVerifier('фраза');
      expect(verifyPassphrase('фраза', verifier)).toBe(true);
      expect(verifyPassphrase('другая', verifier)).toBe(false);
      expect(verifyPassphrase('фраза', 'nonsense')).toBe(false);
      expect(verifyPassphrase('фраза', 'aa:bb')).toBe(false);
      expect(isEncryptedBackup(encryptSecret('x', 'p'))).toBe(true);
      expect(isEncryptedBackup(Buffer.from('x'))).toBe(false);
    });
  });

  describe('lenient store (panel semantics kept)', () => {
    it('set, read, mask, clear; empty value clears; oversize refused', () => {
      expect(setStoredKey(dir, 'openai', '  sk-abcdefghijkl  ')).toBe(true);
      expect(hasStoredKey(dir, 'openai')).toBe(true);
      expect(getStoredKey(dir, 'openai')).toBe('sk-abcdefghijkl');
      expect(maskKey('sk-abcdefghijkl')).toBe('sk-…ijkl');
      expect(maskKey('short')).toBe('…rt');
      expect(maskKey('  ')).toBe('');
      expect(setStoredKey(dir, 'openai', 'x'.repeat(MAX_KEY_LENGTH + 1))).toBe(false);
      expect(setStoredKey(dir, 'openai', ' ')).toBe(true);
      expect(hasStoredKey(dir, 'openai')).toBe(false);
      clearStoredKey(dir, 'absent-id');
      expect(readKeyStore(dir)).toEqual({});
    });
  });

  describe('strict presence read (P111: unread is never absent)', () => {
    it('no key file → false, and the read creates no machine secret', () => {
      expect(readKeyPresence(dir, 'anthropic')).toBe(false);
      expect(readKeyStrict(dir, 'anthropic')).toBeUndefined();
      expect(existsSync(join(dir, 'provider-keys.key'))).toBe(false);
    });

    it('a stored key → true; another id → false; the strict value matches', () => {
      setStoredKey(dir, 'endpoint:p1', 'sk-test-1234567890');
      expect(readKeyPresence(dir, 'endpoint:p1')).toBe(true);
      expect(readKeyPresence(dir, 'platform:c1')).toBe(false);
      expect(readKeyStrict(dir, 'endpoint:p1')).toBe('sk-test-1234567890');
    });

    it('key file present, machine secret lost → throws master-missing (lenient read says empty)', () => {
      setStoredKey(dir, 'anthropic', 'sk-a');
      rmSync(join(dir, 'provider-keys.key'));
      expect(codeOf(() => readKeyPresence(dir, 'anthropic'))).toBe('master-missing');
      // Строгое чтение не пересоздало секрет — иначе файл ключей стал бы нерасшифровываемым навсегда.
      expect(existsSync(join(dir, 'provider-keys.key'))).toBe(false);
      expect(readKeyStore(dir)).toEqual({});
    });

    it('empty machine secret file → master-missing', () => {
      setStoredKey(dir, 'anthropic', 'sk-a');
      writeFileSync(join(dir, 'provider-keys.key'), '  ');
      expect(codeOf(() => readKeyPresence(dir, 'anthropic'))).toBe('master-missing');
    });

    it('machine secret replaced → decrypt-failed', () => {
      setStoredKey(dir, 'anthropic', 'sk-a');
      writeFileSync(join(dir, 'provider-keys.key'), 'another-secret');
      expect(codeOf(() => readKeyPresence(dir, 'anthropic'))).toBe('decrypt-failed');
    });

    it('garbage key file → not-encrypted', () => {
      setStoredKey(dir, 'anthropic', 'sk-a');
      writeFileSync(join(dir, 'provider-keys.enc'), 'garbage');
      expect(codeOf(() => readKeyPresence(dir, 'anthropic'))).toBe('not-encrypted');
      expect(getStoredKey(dir, 'anthropic')).toBeUndefined();
    });

    it('decrypted content not JSON or not an object → store-garbage', () => {
      setStoredKey(dir, 'anthropic', 'sk-a');
      const master = 'm'.repeat(64);
      writeFileSync(join(dir, 'provider-keys.key'), master);
      writeFileSync(join(dir, 'provider-keys.enc'), encryptSecret('not json', master));
      expect(codeOf(() => readKeyPresence(dir, 'anthropic'))).toBe('store-garbage');
      writeFileSync(join(dir, 'provider-keys.enc'), encryptSecret('[1]', master));
      expect(codeOf(() => readKeyStrict(dir, 'anthropic'))).toBe('store-garbage');
    });
  });
});
