import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spelledOnDisk } from './disk-spelling.ts';

const win = process.platform === 'win32';

/**
 * F-326. Под ссылкой (junction/symlink) написание пути не сводилось: `…\link`
 * и `…\LINK` давали два ключа реестров для одного проекта. Сама ссылка при этом
 * не раскрывается — проект остаётся по своему пути.
 */
describe.runIf(win)('spelledOnDisk под ссылкой', () => {
  let base = '';
  beforeEach(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-spelled-')));
    mkdirSync(join(base, 'Real', 'Sub'), { recursive: true });
    symlinkSync(join(base, 'Real'), join(base, 'Link'), 'junction');
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('регистр и слэши сводятся к написанию на диске, ссылка не раскрывается', () => {
    const want = join(base, 'Link', 'Sub');
    for (const typed of [
      want,
      join(base, 'LINK', 'sub'),
      join(base, 'link', 'SUB'),
      want.toLowerCase(),
    ]) {
      expect(spelledOnDisk(typed)).toBe(want);
    }
    expect(spelledOnDisk(join(base, 'lInK'))).toBe(join(base, 'Link'));
  });
});
