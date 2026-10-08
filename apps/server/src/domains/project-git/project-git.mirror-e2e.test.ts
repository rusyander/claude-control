import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { addWorktree, removeWorktree } from './project-git.ts';
import { createE2eFolder, e2eLinkedRoot } from '../project-tests/e2e-folder/e2e-folder.ts';

/**
 * Копия ветки и папка e2e панели — на НАСТОЯЩЕМ `git worktree`. Папка скрыта от
 * git, чекаут её не несёт, поэтому копия видит её ссылкой на оригинал: тест,
 * написанный в копии, ложится в папку оригинала, `git status` копии чист, а
 * удаление копии снимает ссылку, не трогая файлов оригинала.
 */

function dropTemp(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Остаётся в temp.
  }
}

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

const gitIn = (dir: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });

describe.skipIf(!hasGit())('копия ветки и папка e2e панели', () => {
  let dir = '';
  let siblings = '';
  let home = '';
  let appData = '';
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cc-mirror-e2e-home-'));
    for (const key of ['XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL'] as const)
      saved[key] = process.env[key];
    process.env.XDG_CONFIG_HOME = home;
    process.env.GIT_CONFIG_GLOBAL = join(home, 'gitconfig');
    writeFileSync(join(home, 'gitconfig'), '');
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-mirror-e2e-')));
    appData = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-mirror-e2e-data-')));
    siblings = join(dirname(dir), `${basename(dir)}-worktrees`);
    gitIn(dir, 'init', '--initial-branch=main');
    gitIn(dir, 'config', 'user.email', 'test@example.invalid');
    gitIn(dir, 'config', 'user.name', 'Test');
    gitIn(dir, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(dir, 'app.txt'), 'app\n');
    gitIn(dir, 'add', '-A');
    gitIn(dir, 'commit', '-m', 'init');
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    dropTemp(siblings);
    dropTemp(dir);
    dropTemp(appData);
    dropTemp(home);
  });

  it('папка панели — ссылкой: тест копии у оригинала, git копии чист, удаление снимает только ссылку', async () => {
    createE2eFolder(appData, dir, '2026-09-26T10:00:00.000Z');
    const created = await addWorktree(dir, 'feature/e2e');
    const copy = created.path;

    expect(lstatSync(join(copy, 'e2e')).isSymbolicLink()).toBe(true);
    expect(created.mirror?.unlisted ?? []).not.toContain('e2e');
    // Ссылка не видна git ни как каталог, ни как файл: исключение `/e2e` без слэша.
    expect(gitIn(copy, 'status', '--porcelain', '--untracked-files=all').trim()).toBe('');
    expect(e2eLinkedRoot(copy)).toBe(dir);
    expect(e2eLinkedRoot(dir)).toBeUndefined();

    writeFileSync(join(copy, 'e2e', 'pay.spec.ts'), "test('оплата', async () => {});\n");
    expect(readFileSync(join(dir, 'e2e', 'pay.spec.ts'), 'utf8')).toContain('оплата');

    await removeWorktree(dir, copy);
    expect(existsSync(copy)).toBe(false);
    expect(existsSync(join(dir, 'e2e', 'pay.spec.ts'))).toBe(true);
    expect(existsSync(join(dir, 'e2e', 'playwright.config.ts'))).toBe(true);
  });

  it('метку конфига стёрли — удаление копии всё равно снимает ссылку, файлы оригинала целы (F-128)', async () => {
    createE2eFolder(appData, dir, '2026-09-26T10:00:00.000Z');
    const copy = (await addWorktree(dir, 'feature/edited')).path;
    writeFileSync(join(dir, 'e2e', 'pay.spec.ts'), "test('оплата', async () => {});\n");
    // Человек переписал конфиг: первой строки-метки заготовки больше нет.
    writeFileSync(join(dir, 'e2e', 'playwright.config.ts'), 'export default {};\n');

    await removeWorktree(dir, copy);

    expect(existsSync(copy)).toBe(false);
    expect(existsSync(join(dir, 'e2e', 'pay.spec.ts'))).toBe(true);
    expect(readFileSync(join(dir, 'e2e', 'playwright.config.ts'), 'utf8')).toBe(
      'export default {};\n',
    );
  });

  it('своя папка проекта в git едет чекаутом, ссылки нет', async () => {
    mkdirSync(join(dir, 'e2e'));
    writeFileSync(join(dir, 'e2e', 'own.spec.ts'), "test('своё', async () => {});\n");
    gitIn(dir, 'add', '-A');
    gitIn(dir, 'commit', '-m', 'own e2e');
    const created = await addWorktree(dir, 'feature/own');
    expect(lstatSync(join(created.path, 'e2e')).isSymbolicLink()).toBe(false);
    expect(existsSync(join(created.path, 'e2e', 'own.spec.ts'))).toBe(true);
    expect(e2eLinkedRoot(created.path)).toBeUndefined();
  });

  it('своя папка проекта вне git ссылкой не становится: ссылка — только у заготовки панели', async () => {
    // Папка человека, скрытая им самим: панель её не заводила и общей не делает.
    writeFileSync(join(dir, '.gitignore'), '/e2e\n');
    gitIn(dir, 'add', '-A');
    gitIn(dir, 'commit', '-m', 'ignore e2e');
    mkdirSync(join(dir, 'e2e'));
    writeFileSync(join(dir, 'e2e', 'own.spec.ts'), "test('своё', async () => {});\n");
    const created = await addWorktree(dir, 'feature/ignored');
    expect(created.mirror?.linked ?? []).not.toContain('e2e');
    expect(e2eLinkedRoot(created.path)).toBeUndefined();
    let isLink = false;
    try {
      isLink = lstatSync(join(created.path, 'e2e')).isSymbolicLink();
    } catch {
      // Не приехала вовсе — тоже не ссылка.
    }
    expect(isLink).toBe(false);
  });
});
