import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { layoutForCwd } from './cwd-layout.ts';

/**
 * Раскладка копии, собранная теми двумя файлами, что пишет git: `.git`-файл копии
 * с `gitdir:` и `commondir`. Указатель — настоящий путь, как его пишет git
 * (Linux 20.10: корень `/work → /real/work` дал `gitdir: /real/work/…`).
 */
describe('layoutForCwd', () => {
  let root = '';

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-layout-')));
    const meta = join(root, 'app', '.git', 'worktrees', 'g1');
    mkdirSync(meta, { recursive: true });
    writeFileSync(join(meta, 'commondir'), '../..\n');
    mkdirSync(join(root, 'app-worktrees', 'g1'), { recursive: true });
    writeFileSync(join(root, 'app-worktrees', 'g1', '.git'), `gitdir: ${meta}\n`);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('копия — основная рядом', () => {
    expect(layoutForCwd(join(root, 'app-worktrees', 'g1'))).toEqual({
      mainDir: join(root, 'app'),
      copyDir: join(root, 'app-worktrees', 'g1'),
    });
  });

  // Реестр знает проект по пути через ссылку; основная в написании git его не находила.
  it.skipIf(process.platform === 'win32')(
    'корень за ссылкой — основная копия в написании копии, а не git',
    () => {
      const via = join(root, 'via');
      symlinkSync(root, via);
      expect(layoutForCwd(join(via, 'app-worktrees', 'g1', 'src'))).toEqual({
        mainDir: join(via, 'app'),
        copyDir: join(via, 'app-worktrees', 'g1'),
      });
    },
  );
});
