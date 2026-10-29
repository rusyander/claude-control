import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ensureTokenFile, readToken } from './token-file.ts';

const root = mkdtempSync(join(tmpdir(), 'token-recover-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Файл старше окна «сосед ещё пишет» — как оставленный падением. */
function leftover(name: string, text: string): string {
  const path = join(root, name);
  writeFileSync(path, text);
  const old = new Date(Date.now() - 60_000);
  utimesSync(path, old, old);
  return path;
}

describe('F-58 core token — a token file left broken by a crash does not wedge every boot', () => {
  it.each([
    ['empty', ''],
    ['5 chars', 'abcde\n'],
    ['unparsable', 'not a token at all, spaces and !!\n'],
  ])(
    'F-58 %s token file → regenerated (created), a valid token read back from disk',
    (label, text) => {
      const path = leftover(`token-${label.replace(/\W/g, '')}`, text);
      const out = ensureTokenFile(path);
      expect(out.created).toBe(true);
      expect(out.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(readToken(path)).toEqual({ value: out.token });
      if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
      // Второй старт читает тот же токен, не плодит новый.
      expect(ensureTokenFile(path)).toMatchObject({ created: false, token: out.token });
    },
  );

  it('F-58 a valid token is never replaced', () => {
    const valid = 'B'.repeat(43);
    const path = leftover('token-valid', `${valid}\n`);
    expect(ensureTokenFile(path)).toMatchObject({ created: false, token: valid });
  });
});
