import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { copyRootOf } from './group-copy-root.ts';

describe('copyRootOf — корень копии группы по каталогу прогона', () => {
  const base = mkdtempSync(join(tmpdir(), 'copy-root-'));
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('подпроект копии ветки — корень там, где `.git`', () => {
    const copy = join(base, 'shop-worktrees', 'feat-x');
    mkdirSync(join(copy, 'inst-config', 'src'), { recursive: true });
    writeFileSync(join(copy, '.git'), 'gitdir: /elsewhere/.git/worktrees/feat-x\n');
    expect(copyRootOf(join(copy, 'inst-config', 'src'))).toBe(copy);
    expect(copyRootOf(copy)).toBe(copy);
  });

  it('основная копия с каталогом `.git` — её корень', () => {
    const main = join(base, 'shop');
    mkdirSync(join(main, '.git'), { recursive: true });
    mkdirSync(join(main, 'apps', 'web'), { recursive: true });
    expect(copyRootOf(join(main, 'apps', 'web'))).toBe(main);
  });

  it('удалённая копия панели — по раскладке `<репозиторий>-worktrees/<каталог>`', () => {
    const none = (): boolean => false;
    expect(copyRootOf('C:\\work\\shop-worktrees\\feat-x\\inst-config', none)).toBe(
      'C:\\work\\shop-worktrees\\feat-x',
    );
    expect(copyRootOf('/home/me/shop-worktrees/feat-x/a/b', none)).toBe(
      '/home/me/shop-worktrees/feat-x',
    );
  });

  it('не репозиторий и не копия панели — сам каталог', () => {
    const none = (): boolean => false;
    expect(copyRootOf('C:\\work\\notes\\draft', none)).toBe('C:\\work\\notes\\draft');
    expect(copyRootOf('/home/me/shop-worktrees', none)).toBe('/home/me/shop-worktrees');
  });
});
