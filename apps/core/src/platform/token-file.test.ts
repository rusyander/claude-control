import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ensureTokenFile, readToken, tokenEquals } from './token-file.ts';
import { currentOs } from './os-kind.ts';

/**
 * Токен ядра (09 §token file mode): создаётся один раз `wx`, читается назад по форме, на POSIX
 * режим 0600 приводится и проверяется чтением назад; где режим не держится — отказ, а не
 * «0600» на словах.
 */

const root = mkdtempSync(join(tmpdir(), 'core token ü '));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const VALID = 'A'.repeat(43);

describe('09 core token file', () => {
  it('09 token: created once (wx), the same 43-char token read back on the second call; modeChecked names the OS rule', () => {
    const path = join(root, 'fresh', 'token');
    const first = ensureTokenFile(path);
    expect(first.created).toBe(true);
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const second = ensureTokenFile(path);
    expect(second).toMatchObject({ created: false, token: first.token });
    expect(first.modeChecked).toBe(currentOs() === 'win32' ? 'windows-profile-acl' : 'posix-0600');
    expect(ensureTokenFile(path, 'win32').modeChecked).toBe('windows-profile-acl');
  });

  it('09 token: a fresh file of the wrong form is waited out (a neighbour may be writing it), then replaced (F-58); absent reads as absent', () => {
    const path = join(root, 'garbage-token');
    writeFileSync(path, 'not a token\n');
    expect(readToken(path)).toEqual({ unknown: 'garbage: token file has wrong form' });
    const started = Date.now();
    const out = ensureTokenFile(path);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_500);
    expect(out).toMatchObject({ created: true });
    expect(readToken(path)).toEqual({ value: out.token });
    expect(readToken(join(root, 'no-such-token'))).toEqual({ absent: true });
  });

  it.runIf(process.platform !== 'win32')(
    '09 token POSIX: a token file that arrived 0644 (copy, unpack) is brought to 0600 and read back',
    () => {
      const path = join(root, 'loose-token');
      writeFileSync(path, `${VALID}\n`);
      chmodSync(path, 0o644);
      expect(ensureTokenFile(path, 'linux')).toMatchObject({ token: VALID, created: false });
      expect(statSync(path).mode & 0o777).toBe(0o600);
    },
  );

  it.runIf(process.platform === 'win32')(
    '09 token: POSIX rule on a filesystem that cannot hold 0600 → refused with the path, never reported as 0600',
    () => {
      const path = join(root, 'win-token');
      writeFileSync(path, `${VALID}\n`);
      expect(() => ensureTokenFile(path, 'linux')).toThrow(/core token mode is not 0600/);
    },
  );

  it.runIf(process.platform === 'win32')(
    '09 token Windows (F-122): the real ACL of a created token grants nothing to Everyone, Users or Authenticated Users; a widened file is seen',
    () => {
      // Метка `windows-profile-acl` — только слово; проверяется сам ACL файла: SID'ы разрешающих
      // записей, прочитанные PowerShell'ом (имена групп локализованы, SID'ы — нет).
      const allowSids = (file: string): string[] =>
        execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            '(Get-Acl -LiteralPath $env:ACL_FILE).Access | Where-Object { $_.AccessControlType -eq "Allow" } | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }',
          ],
          { encoding: 'utf8', env: { ...process.env, ACL_FILE: file }, windowsHide: true },
        )
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
      const BROAD = ['S-1-1-0', 'S-1-5-32-545', 'S-1-5-11', 'S-1-5-7', 'S-1-5-4'];
      const path = join(root, 'acl', 'token');
      expect(ensureTokenFile(path).modeChecked).toBe('windows-profile-acl');
      const sids = allowSids(path);
      // Хоть одна разрешающая запись есть (иначе пустой список доказал бы только сбой чтения).
      expect(sids.length).toBeGreaterThan(0);
      expect(sids.filter((sid) => BROAD.includes(sid))).toEqual([]);
      // Контроль, что проверка умеет краснеть: тот же файл, открытый всем, она видит.
      const widened = join(root, 'acl', 'widened');
      writeFileSync(widened, `${VALID}\n`);
      execFileSync('icacls', [widened, '/grant', '*S-1-1-0:R'], { windowsHide: true });
      expect(allowSids(widened)).toContain('S-1-1-0');
    },
  );

  it('09 tokenEquals: equal only for the same bytes; a different length is unequal without throwing', () => {
    expect(tokenEquals(VALID, VALID)).toBe(true);
    expect(tokenEquals(VALID, `${'A'.repeat(42)}B`)).toBe(false);
    expect(tokenEquals(VALID, 'short')).toBe(false);
  });
});
