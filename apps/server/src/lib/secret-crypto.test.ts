import { describe, it, expect } from 'vitest';
import {
  encryptSecret,
  decryptSecret,
  isEncryptedBackup,
  makeVerifier,
  verifyPassphrase,
} from './secret-crypto.ts';

/**
 * Шифрование резервных копий файла секретов. Проверяем три вещи, ради которых
 * всё и затевалось: содержимое переживает round-trip шифр→дешифр без потерь,
 * неверная парольная фраза внятно отвергается (а не отдаёт мусор), и verifier
 * позволяет отличить правильную фразу от неправильной, не храня саму фразу.
 */
describe('Шифрование копий секретов', () => {
  const SECRET = 'GITHUB_TOKEN=ghp_секретное_значение_123\n# комментарий\nAPI_KEY=xyz\n';
  const PASS = 'верная-парольная-фраза';

  describe('round-trip', () => {
    it('дешифр возвращает ровно исходный текст', () => {
      const blob = encryptSecret(SECRET, PASS);
      expect(decryptSecret(blob, PASS)).toBe(SECRET);
    });

    it('шифротекст не содержит исходных значений открытым текстом', () => {
      const blob = encryptSecret(SECRET, PASS);
      expect(blob.toString('utf8')).not.toContain('ghp_секретное_значение_123');
      expect(blob.toString('latin1')).not.toContain('ghp_');
    });

    it('одинаковый текст шифруется каждый раз по-разному (своя соль и iv)', () => {
      const a = encryptSecret(SECRET, PASS);
      const b = encryptSecret(SECRET, PASS);
      expect(a.equals(b)).toBe(false);
      // но оба расшифровываются в одно и то же
      expect(decryptSecret(a, PASS)).toBe(decryptSecret(b, PASS));
    });

    it('пустое содержимое тоже переживает round-trip', () => {
      const blob = encryptSecret('', PASS);
      expect(decryptSecret(blob, PASS)).toBe('');
    });
  });

  describe('неверная фраза', () => {
    it('дешифр другой фразой бросает внятную ошибку', () => {
      const blob = encryptSecret(SECRET, PASS);
      expect(() => decryptSecret(blob, 'другая-фраза')).toThrow(/Неверная парольная фраза/);
    });

    it('повреждённый шифротекст бросает ошибку, а не отдаёт мусор', () => {
      const blob = encryptSecret(SECRET, PASS);
      blob[blob.length - 1]! ^= 0xff; // портим последний байт
      expect(() => decryptSecret(blob, PASS)).toThrow();
    });
  });

  describe('распознавание формата', () => {
    it('наш блок опознаётся как зашифрованный', () => {
      expect(isEncryptedBackup(encryptSecret(SECRET, PASS))).toBe(true);
    });

    it('обычный текст не считается зашифрованной копией', () => {
      expect(isEncryptedBackup(Buffer.from('KEY=value\n', 'utf8'))).toBe(false);
    });

    it('дешифр не-нашего блока отвергается до попытки расшифровки', () => {
      expect(() => decryptSecret(Buffer.from('обычный текст'), PASS)).toThrow(/не зашифрованная/);
    });
  });

  describe('verifier', () => {
    it('верная фраза проходит проверку verifier', () => {
      const verifier = makeVerifier(PASS);
      expect(verifyPassphrase(PASS, verifier)).toBe(true);
    });

    it('неверная фраза не проходит', () => {
      const verifier = makeVerifier(PASS);
      expect(verifyPassphrase('не та фраза', verifier)).toBe(false);
    });

    it('verifier не содержит саму фразу', () => {
      const verifier = makeVerifier(PASS);
      expect(verifier).not.toContain(PASS);
    });

    it('кривой verifier — это «не совпало», а не исключение', () => {
      expect(verifyPassphrase(PASS, 'мусор-без-двоеточия')).toBe(false);
      expect(verifyPassphrase(PASS, '')).toBe(false);
    });
  });
});
