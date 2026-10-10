import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Файл токена доступа — во временном домашнем каталоге (`HOME`/`USERPROFILE`
 * подменены, настоящий `~/.agentdeck` не трогается). Токен — Bearer ко всему API
 * панели, поэтому его права обязаны быть 0600 и после ротации: `mode` у
 * `writeFileSync` действует только на новый файл, и прежний широкий режим
 * переживал перезапись. Права проверяются на POSIX (CI на Linux).
 */
let home = '';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'api-token-home-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('файл токена доступа', () => {
  it('создаётся в домашнем каталоге панели, ротация меняет содержимое', async () => {
    const { apiTokenPath, readApiToken, rotateApiToken } = await import('./api-token.ts');
    const path = apiTokenPath();
    expect(path.startsWith(home)).toBe(true);

    const first = readApiToken();
    expect(readFileSync(path, 'utf8')).toBe(`${first}\n`);
    const second = rotateApiToken();
    expect(second).not.toBe(first);
    expect(readFileSync(path, 'utf8')).toBe(`${second}\n`);
  });

  it.runIf(process.platform !== 'win32')(
    'ротация поверх файла с широкими правами — снова 0600, каталог панели 0700',
    async () => {
      const { apiTokenPath, readApiToken, rotateApiToken } = await import('./api-token.ts');
      readApiToken();
      const path = apiTokenPath();
      chmodSync(path, 0o644);
      chmodSync(dirname(path), 0o755);

      rotateApiToken();

      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    },
  );
});
