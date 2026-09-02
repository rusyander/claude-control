import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePanelCredentials } from './credentials.ts';

/**
 * `readFrom` на каталог проходил проверку («существует»), сохранялся и тут же
 * читался как «не найден». Проверяем до записи: файл, и читаемый.
 */
describe('credentials: readFrom должен быть читаемым файлом', () => {
  it('каталог отклоняется с понятной причиной', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-readfrom-'));
    try {
      const result = validatePanelCredentials(JSON.stringify({ readFrom: dir }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('каталог, а не файл');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('несуществующий путь — «не найден»', () => {
    const result = validatePanelCredentials(
      JSON.stringify({ readFrom: join(tmpdir(), 'cc-no-such-file-9f3a.json') }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('не найден');
  });

  it('обычный файл принимается', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-readfrom-ok-'));
    try {
      const file = join(dir, 'creds.json');
      writeFileSync(file, '{"claudeAiOauth":{"accessToken":"x"}}');
      expect(validatePanelCredentials(JSON.stringify({ readFrom: file }))).toEqual({ ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('readFrom не строкой не роняет проверку', () => {
    expect(validatePanelCredentials(JSON.stringify({ readFrom: 42 })).ok).toBe(false);
  });
});
